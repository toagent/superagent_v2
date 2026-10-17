import { parseWholeOutputRef } from '../../packages/workflows/src/output-ref';
import { admitExecution, resumeExecution } from '@archon/workflows/execution-lifecycle';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as coordModule from '../src/coord';
import * as launcherModule from '../src/launcher';
import * as relay from '../src/relay-quota';
import * as saCheck from '../templates/.archon/scripts/sa-check';
import { askKey } from '../src/cockpit-signals';
import { Database } from 'bun:sqlite';
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import * as fs from 'node:fs';
import * as archonMod from '../src/archon';
import * as cliMod from '../src/cli';
import * as gcMod from '../src/gc';
import { captureDelivery } from '../src/land';
import * as landMod from '../src/land';
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
  main,
  parseArgs,
  quickPlan,
  superviseTickCli,
  updateLedger,
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
import { rowOf } from '../src/board/data';
import {
  acceptanceNodeEnvironment,
  directAuxiliaryPreload,
  fixturePlan,
  gitRepo,
  sh,
  tmp,
} from './helpers';
import { resolveAcceptanceContext } from '../src/role-context';
import { fixtureArchon, fixtureOptions } from './fixtures/archon-stub';

const engineRecoverLock = () => {
  const root = join(process.env.ARCHON_HOME ?? '', 'execution-admissions');
  mkdirSync(root, { recursive: true });
  return archonMod.lock(join(root, 'r.lock'));
};
const BIN = join(import.meta.dir, '..', 'bin', 'superagent');
const supervisorTransport = cliMod.supervisor;
const fixtureDecision = (kind: 'advance' | 'repair' | 'block', reason: string | null = null) => ({
  kind,
  reason,
  evidence: [],
  debt: [],
});
let engineBoundary: ReturnType<typeof spyOn<typeof coordModule, 'cleanEngine'>> | undefined;
const cleanEngine = coordModule.cleanEngine;
const originalBunOptions = process.env.BUN_OPTIONS;
const originalMemory = process.env.SUPERAGENT_MEMORY;
const originalGitConfig = process.env.GIT_CONFIG_GLOBAL;
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
  if (originalBunOptions === undefined) delete process.env.BUN_OPTIONS;
  else process.env.BUN_OPTIONS = originalBunOptions;
  if (originalMemory === undefined) delete process.env.SUPERAGENT_MEMORY;
  else process.env.SUPERAGENT_MEMORY = originalMemory;
  if (originalGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = originalGitConfig;
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
    expect(admitExecution(host).ok).toBe(false);
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
  const invoke = () =>
    Bun.spawnSync(
      [process.execPath, join(import.meta.dir, '../src/cli.ts'), 'plan', 'check', path],
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
      expect(JSON.parse(readFileSync(path, 'utf8')).request_ref).toBe('urgent-1015');
      expect(plan.repo).toBe(repo);
      expect(plan.base_ref).toBe('main');
      expect(plan.budget).toEqual({ weighted_tokens: 0, unlimited_tokens: true });
      expect(plan.deadline).toBeUndefined();
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
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(main(['--help'])).toBe(0);
      expect(String(log.mock.calls[0]?.[0])).toContain('--card <file>');
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
    `#!/usr/bin/env bash\nexec '${process.execPath}' '${join(import.meta.dir, 'fixtures/archon-stub.ts')}' '${dir}' "$@"\n`
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
  const due = spyOn(archonMod, 'dueWorkflowContinuations').mockReturnValue(['r']);
  fixtureSpies.push(
    // Scratch cleanup has dedicated real-process coverage in scratch.test.ts.
    // Control fixtures must not scan or clean unrelated operator sessions.
    spyOn(gcMod, 'scratchClean').mockReturnValue([]),
    spyOn(gcMod, 'gc').mockReturnValue([]),
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
  supervisor(root, 'pending');
  return { dir, root, ledger, calls, due };
}

describe('HF3 latest-engine recovery', () => {
  const setup = (hash?: string) => {
    const s = stub([run('failed')]);
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
      const s = setup('old');
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
    if (sample !== 'missing')
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
            { nodeId: 'gate-m1-r1', state: 'failed' },
          ],
        })
      )
    );
    writeFileSync(join(s.ledger.gen_dir, 'engine.json'), JSON.stringify({ fake: false }));
    expect(captured(() => main(['decide', 'sa1', 'retry']))).toMatchObject({ code: 0 });
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
    expect(nodes.find(n => n.id === 'verify-core')?.with?.delta_base).toBe('$start-m1.output.head');
    const carried = sample === 'verify' || sample === 'settle';
    expect(l.adoptions?.at(-1)?.carried).toEqual(carried ? ['core'] : []);
    if (carried) {
      expect(code?.when).toBe("$package-attempt-core.output.attempt != '0'");
      const binding = nodes.find(n => n.id === 'verify-core')?.with?.coder as {
        if_skipped: string;
      };
      expect(JSON.parse(binding.if_skipped)).toMatchObject({
        status: 'done',
        error_class: null,
        notes: 'carried from r',
      });
    } else expect(code?.when).toBeUndefined();
    expect(code?.command).toBe('sa-code');
    expect(nodes.find(n => n.id === 'code-api')?.command).toBe('sa-code');
    expect(nodes.find(n => n.id === 'verify-core')?.script).toBe('sa-check');
    expect(nodes.find(n => n.id === 'repair-core')?.command).toBe('sa-repair');
    expect(nodes.find(n => n.id === 'settle-core')?.script).toBe('sa-check');
    expect(sh('git rev-parse HEAD', worktree).trim()).not.toBe(head);
  });
  test('old ledger adopts with fresh source and preserves runtime files', () => {
    const s = setup();
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
      const s = setup('old');
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

/**
 * supervisor.py 桩：ask 回固定 id；ask-status 回 answer 文件内容；调用记入 sup-calls。stub() 默认装上（answer=pending），
 * 任何测试都不会落到真实提醒事项。
 */
function supervisor(root: string, answer: string): () => string[] {
  const py = join(root, 'supervisor.py');
  writeFileSync(
    py,
    `import os, sys\nd = os.path.dirname(os.path.abspath(__file__))\nopen(os.path.join(d, 'sup-calls'), 'a').write(' '.join(sys.argv[1:]) + '\\n')\nif sys.argv[1] not in ('ask', 'ask-status', 'ask-ack'): sys.exit(2)\nprint('ask-1' if sys.argv[1] == 'ask' else open(os.path.join(d, 'answer')).read().strip())\n`
  );
  writeFileSync(join(root, 'answer'), answer);
  process.env.SA_SUPERVISOR = py;
  const source = readFileSync(py, 'utf8');
  fixtureSpies.push(
    spyOn(cliMod, 'supervisor').mockImplementation(args => {
      // Custom failure/snapshot scripts still exercise the native subprocess boundary.
      if (process.env.SA_SUPERVISOR !== py || readFileSync(py, 'utf8') !== source)
        return supervisorTransport(args);
      appendFileSync(join(root, 'sup-calls'), args.join(' ') + '\n');
      if (args[0] === 'ask') return 'ask-1';
      if (args[0] === 'ask-ack') return 'ok';
      if (args[0] === 'ask-status') return readFileSync(join(root, 'answer'), 'utf8').trim();
      throw new Error(`unexpected fixture supervisor command: ${args[0]}`);
    })
  );
  return () =>
    existsSync(join(root, 'sup-calls'))
      ? readFileSync(join(root, 'sup-calls'), 'utf8').trim().split('\n')
      : [];
}

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

describe('HF5 episode regressions', () => {
  test('M2-03 consecutive human signoffs each ask once; old yes cannot sign the next milestone', () => {
    const first = humanWait(new Date(Date.now() + 3600000).toISOString());
    first.metadata!.wait!.waitingSince = '2026-10-10T10:00:00Z';
    const s = stub([first, first, run('running')]);
    const tick = () => JSON.parse(captured(() => main(['supervise-tick'])).out).actions[0];
    expect(tick()).toMatchObject({ action: 'ask' });
    supervisor(s.root, 'yes');
    expect(tick()).toMatchObject({ action: 'approve' });
    const next = humanWait(new Date(Date.now() + 3600000).toISOString());
    next.metadata!.wait!.nodeId = 'human-m3';
    next.metadata!.wait!.event = 'sa.human.m3';
    next.metadata!.wait!.waitingSince = '2026-10-10T11:00:00Z';
    for (const f of readdirSync(s.dir).filter(f => /^get-.*json$/.test(f)))
      writeFileSync(join(s.dir, f), JSON.stringify(next));
    expect(tick()).toMatchObject({ action: 'ask' });
    expect(s.calls().filter(c => c.startsWith('workflow signal'))).toHaveLength(1);
    const asks = JSON.parse(readFileSync(join(s.root, 'home/asks.json'), 'utf8'));
    expect(asks[askKey('sa1', 'signoff', 'human-m3@2026-10-10T11:00:00Z')].status).toBe('pending');
  });
  test('M2-03 superseded hold returns with a new waitingSince and gets a fresh question', () => {
    const first = humanWait(new Date(Date.now() + 3600000).toISOString());
    first.metadata!.wait!.waitingSince = '2026-10-10T10:00:00Z';
    const s = stub([first]);
    const tick = () => JSON.parse(captured(() => main(['supervise-tick'])).out).actions;
    expect(tick()[0]).toMatchObject({ action: 'ask' });
    writeFileSync(join(s.dir, 'get-000.json'), JSON.stringify(run('running')));
    tick();
    supervisor(s.root, 'yes');
    first.metadata!.wait!.waitingSince = '2026-10-10T12:00:00Z';
    writeFileSync(join(s.dir, 'get-000.json'), JSON.stringify(first));
    expect(tick()[0]).toMatchObject({ action: 'ask' });
    expect(s.calls().filter(c => c.startsWith('workflow signal'))).toHaveLength(0);
    const asks = JSON.parse(readFileSync(join(s.root, 'home/asks.json'), 'utf8'));
    expect(asks[askKey('sa1', 'signoff', 'human-m2@2026-10-10T10:00:00Z')].status).toBe(
      'superseded'
    );
  });
});

describe('waitRun (archon stub)', () => {
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
  test('wait native block surfaces inbox before another get', () => {
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
      state: 'surfaced',
      at: '',
    };
    const inbox = spyOn(coordModule.coord(), 'surfaced')
      .mockReturnValueOnce([])
      .mockReturnValue([message]);
    try {
      expect(waitRun(s.ledger, 60)).toMatchObject({ state: 'inbox', exit: EXIT.held });
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
  test('timeout while running returns 4 without blocking past deadline', () => {
    const s = stub([run('running')]);
    expect(waitRun(s.ledger, 0)).toMatchObject({ state: 'running', exit: EXIT.running });
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
  test('owner_lost stays observable; wait and tick do not mutate the engine or legacy controls', () => {
    const lost = run('running', { metadata: { execution_owner: LOST } });
    const s = stub([lost]);
    const db = runsDb(LOST);
    const before = readFileSync(ledgerPath('sa1'), 'utf8');
    expect(waitRun(s.ledger, 30)).toMatchObject({
      state: 'owner_lost',
      action: 'superagent recover sa1',
    });
    captured(() => main(['supervise-tick']));
    expect(db.query('select status from remote_agent_workflow_runs').get()).toEqual({
      status: 'running',
    });
    expect(s.calls().some(c => c.startsWith('workflow resume'))).toBe(false);
    const historical = JSON.parse(before);
    const after = loadLedger('sa1');
    for (const field of ['recoveries', 'auto_retries', 'progress_fp', 'stalled'] as const)
      expect(after[field]).toEqual(historical[field]);
    db.close();
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
  });
  test('cancel: a paused or failed run is abandoned (the engine refuses cancel for them)', () => {
    for (const r of [humanWait(), run('failed')]) {
      const s = stub([r]);
      expect(captured(() => main(['cancel', 'sa1'])).code).toBe(0);
      expect(s.calls()).toContain('workflow abandon r --json');
      expect(s.calls().some(c => c.startsWith('workflow cancel'))).toBe(false);
    }
  });
  test('cancel: a run that paused between get and cancel is re-read and abandoned', () => {
    const s = stub([run('running'), humanWait()]);
    expect(captured(() => main(['cancel', 'sa1'])).code).toBe(0);
    expect(s.calls().filter(c => /^workflow (cancel|abandon)/.test(c))).toEqual([
      'workflow cancel r --json',
      'workflow abandon r --json',
    ]);
  });
  test('cancel: a completed run is refused by abandon and exits 1', () => {
    const s = stub([run('completed')]);
    const { code, out } = captured(() => main(['cancel', 'sa1']));
    expect(code).toBe(1);
    expect(JSON.parse(out)).toEqual({ run_id: 'sa1', ok: false });
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
      const sha = sh('git rev-parse HEAD', repo).trim();
      engineBoundary!.mockImplementation(() => cleanEngine(repo));
      sh(detached ? 'git switch -q --detach HEAD' : 'git switch -qc feature/launch', repo);
      const plan = fixturePlan(s.root, repo, p => {
        p.base_ref = sha;
      });
      const quota = spyOn(relay, 'relayQuota').mockReturnValue({ quota: 'relay fixture' });
      const result = captured(() => main(['run', plan, '--fake']));
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
  const check = (files: string[], exitCode = 0, verbose = false) => {
    stub([]);
    const spawnSync = Bun.spawnSync;
    const checkSpawn = <
      const In extends Bun.SpawnOptions.Writable = 'ignore',
      const Out extends Bun.SpawnOptions.Readable = 'pipe',
      const Err extends Bun.SpawnOptions.Readable = 'pipe',
    >(
      cmd: string[] | (Bun.SpawnOptions.SpawnSyncOptions<In, Out, Err> & { cmd: string[] }),
      options?: Bun.SpawnOptions.SpawnSyncOptions<In, Out, Err>
    ): Bun.SyncSubprocess<Out, Err> => {
      const command = Array.isArray(cmd) ? cmd : cmd.cmd;
      return spawnSync(
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
    withArtifacts('running', {});
    expect(captured(() => main(['land', 'sa1'])).code).toBe(1);
  });
  test('LAND CLI prints a missing-target reason and returns failure without merge commands', () => {
    withArtifacts('failed', {
      'land.json': { commands: [], reason: 'land_target_unknown', action: 'Choose a local branch' },
    });
    const result = captured(() => main(['land', 'sa1']));
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({ commands: [], reason: 'land_target_unknown' });
  });
  test('land omits needs from advanced nodes without asking the operator', () => {
    const need = { cap: 'approval', why: 'obsolete', minimal_ask: 'check process deviation' };
    const art = withArtifacts('completed', {
      'land.json': { commands: ['c'] },
      'verify-core.json': { ok: true, disposition: 'advance' },
      'verify-core.coder.json': { status: 'blocked', needs: [need], milestone: 'm1' },
    });
    const sup = supervisor(join(art, '..', '..', '..', '..'), 'pending');
    expect(captured(() => main(['land', 'sa1'])).out).not.toContain(
      'need approval (verify-core): check process deviation'
    );
    expect(JSON.parse(captured(() => main(['land', 'sa1', '--json'])).out)).toEqual({
      commands: ['c'],
    });
    expect(captured(() => main(['supervise-tick'])).code).toBe(0);
    expect(sup().filter(c => c.startsWith('ask '))).toHaveLength(0);
  });
});

test.each(['normal', 'interrupted', 'receipt-lost', 'foreign', 'stale', 'lease-missing', 'legacy'])(
  'DURABLE_DELIVERY no wait, resume exactly once, receipt reconciliation and fencing: %s',
  kind => {
    const s = stub([]),
      art = join(s.root, 'home/artifacts/runs/r');
    writeFileSync(join(s.root, '.git/info/exclude'), '*\n');
    sh(
      'git config user.name t && git config user.email t@l && git commit --allow-empty -qm seed',
      s.root
    );
    const who = coordModule.caller(),
      c = coordModule.coord();
    const authorization = {
      run: c.claim(coordModule.runScope(s.ledger), who).controller,
      repo: s.ledger.controller!,
    };
    s.ledger.delivery = captureDelivery(s.root);
    const worker = join(tmp(), 'worker');
    sh(`git worktree add -qb sa/sa1 '${worker}'`, s.root);
    sh('echo feature > feature && git add -f feature && git commit -qm feature', worker);
    const head = sh('git rev-parse HEAD', worker).trim();
    writeFileSync(ledgerPath('sa1'), JSON.stringify(s.ledger));
    mkdirSync(art, { recursive: true });
    const view = run('running', {
      working_path: worker,
      output_root: join(s.root, 'home'),
      nodes: [
        { nodeId: 'land', state: 'completed' },
        { nodeId: 'deliver', state: 'running' },
      ],
    });
    writeFileSync(join(s.dir, 'get-000.json'), JSON.stringify(view));
    writeFileSync(join(art, 'land.json'), JSON.stringify({ branch: 'sa/sa1', head }));
    writeFileSync(join(s.ledger.gen_dir, 'accept-inputs.json'), '[]');
    writeFileSync(
      join(s.ledger.gen_dir, 'delivery-authorization.json'),
      JSON.stringify(authorization)
    );
    const priorWorkflow = process.env.WORKFLOW_ID;
    process.env.WORKFLOW_ID = 'r';
    const accept = spyOn(landMod, 'acceptRun').mockReturnValue(0);
    const execute = () =>
      landMod.finalizeDelivery('sa1', false, who, kind === 'legacy' ? undefined : authorization);
    try {
      if (kind === 'foreign')
        c.claim(coordModule.runScope(s.ledger), { ...who, session_id: 'other' }, true, 'fixture');
      if (kind === 'stale') authorization.run.generation++;
      if (kind === 'lease-missing') {
        for (const file of readdirSync(join(s.root, 'home/coord/leases')))
          fs.unlinkSync(join(s.root, 'home/coord/leases', file));
      }
      if (['foreign', 'stale', 'lease-missing'].includes(kind)) {
        expect(execute).toThrow('fencing');
        expect(accept).not.toHaveBeenCalled();
        expect(sh('git rev-parse HEAD', s.root).trim()).toBe(s.ledger.delivery.head);
        return;
      }
      if (kind === 'interrupted') {
        accept.mockImplementationOnce(() => {
          throw new Error('injected interruption before integration');
        });
        expect(execute).toThrow('injected interruption before integration');
        expect(landMod.deliveryRecoverable(view)).toBe(true);
        expect(sh('git rev-parse HEAD', s.root).trim()).toBe(s.ledger.delivery.head);
      }
      if (kind === 'receipt-lost') {
        const rename = spyOn(fs, 'renameSync').mockImplementation(() => {
          throw new Error('injected receipt loss');
        });
        try {
          expect(execute).toThrow('injected receipt loss');
        } finally {
          rename.mockRestore();
        }
        expect(sh('git rev-parse HEAD', s.root).trim()).toBe(head);
        expect(existsSync(join(art, 'delivery.json'))).toBe(false);
      }
      const receipt = execute();
      expect(receipt?.status).toBe('manual_push');
      expect(sh('git rev-parse HEAD', s.root).trim()).toBe(head);
      expect(execute()).toEqual(receipt);
      expect(sh(`git rev-list --count '${s.ledger.delivery.head}..HEAD'`, s.root).trim()).toBe('1');
      expect(s.calls().some(call => call.startsWith('workflow wait'))).toBe(false);
      const before = readFileSync(ledgerPath('sa1'), 'utf8');
      writeFileSync(join(s.dir, 'get-000.json'), JSON.stringify({ ...view, status: 'completed' }));
      expect(
        JSON.parse(captured(() => main(['wait', 'sa1', '--timeout', '1'])).out).delivery
      ).toEqual(receipt);
      expect(readFileSync(ledgerPath('sa1'), 'utf8')).toBe(before);
    } finally {
      accept.mockRestore();
      if (priorWorkflow === undefined) delete process.env.WORKFLOW_ID;
      else process.env.WORKFLOW_ID = priorWorkflow;
    }
  }
);

test.each([
  { name: 'default observe', hard: false, exit: 0, expected: 0 },
  { name: 'hard tokens', hard: true, exit: 0, expected: 0 },
  { name: 'hard launches', hard: true, exit: 0, launches: 1, expected: 0 },
  { name: 'product', hard: false, exit: 1, failure: 'product', expected: 1 },
  { name: 'product zero exit', hard: false, exit: 0, failure: 'product', expected: 1 },
  { name: 'unknown', hard: false, exit: 1, failure: 'unknown', expected: 1 },
  { name: 'non-budget exception', hard: false, exit: 1, reason: 'unexpected', expected: 1 },
])('NO_HOLD BUDGET_ACCEPT $name', sample => {
  const s = stub([]);
  writeFileSync(
    join(s.dir, 'get-000.json'),
    JSON.stringify(
      Object.assign(
        run('completed', {
          working_path: s.root,
          output_root: join(s.root, 'home'),
        }),
        { events: [] }
      )
    )
  );
  const plan = JSON.parse(readFileSync(fixturePlan(s.root, s.root), 'utf8')) as Plan;
  plan.budget = {
    weighted_tokens: 100,
    ...(sample.hard ? { enforcement: 'hard' } : {}),
    ...(sample.launches ? { launches: sample.launches } : {}),
  };
  writeFileSync(join(s.ledger.gen_dir, 'plan.json'), JSON.stringify(plan));
  const art = join(s.root, 'home/artifacts/runs/r'),
    scripts = join(s.ledger.gen_dir, '.archon/scripts');
  mkdirSync(art, { recursive: true });
  mkdirSync(scripts, { recursive: true });
  writeFileSync(
    join(s.ledger.gen_dir, 'accept-inputs.json'),
    JSON.stringify([{ tag: 'diff-m1-r1', milestone: 'm1', risk: 'G1' }])
  );
  writeFileSync(
    join(art, 'policy-attempts.json'),
    JSON.stringify(
      [0, 1].map(id => ({
        id: String(id),
        node: 'code-core',
        provider: 'codex',
        model: 'fixture',
        status: 'completed',
        tokens: { input: 60, output: 0 },
      }))
    )
  );
  const out = {
    ok: !sample.failure,
    diff_hash: 'same',
    contract_hash: 'same',
    same: false,
    disposition: sample.failure ? 'repair' : 'advance',
    reason: sample.reason ?? 'budget_tokens_exceeded',
    ...(sample.failure
      ? {
          failed: ['true'],
          failures: [{ command: 'true', failure_class: sample.failure, evidence: 'real failure' }],
        }
      : {}),
  };
  const script = join(scripts, 'sa-check.ts');
  writeFileSync(
    script,
    `console.log(${JSON.stringify(JSON.stringify(out))}); process.exit(${sample.exit});`
  );
  const frozen = ['diff-m1-r1.json', 'gate-m1-r1.json', 'gate-m1-r1.review.json'];
  frozen.forEach(file =>
    writeFileSync(
      join(art, file),
      JSON.stringify(
        file.startsWith('diff-')
          ? out
          : file.endsWith('review.json')
            ? { status: 'PASS', findings: [], debt: [] }
            : { decision: fixtureDecision('advance') }
      )
    )
  );
  const paths = [
    script,
    join(s.ledger.gen_dir, 'plan.json'),
    ...frozen.map(file => join(art, file)),
  ];
  const before = paths.map(path => readFileSync(path, 'utf8'));
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const result = captured(() => main(['accept', 'sa1']));
    expect(result.code).toBe(sample.expected);
    expect(JSON.parse(result.out).ok).toBe(sample.expected === 0);
    expect(
      warn.mock.calls.some(
        ([line]) => JSON.parse(String(line)).code === 'superagent.budget_observed'
      )
    ).toBe(true);
    if (!sample.expected) expect(JSON.parse(result.out)).toMatchObject({ disposition: 'advance' });
    expect(paths.map(path => readFileSync(path, 'utf8'))).toEqual(before);
    expect(s.calls().every(call => call.startsWith('workflow get r'))).toBe(true);
  } finally {
    warn.mockRestore();
  }
});

test.each([true, false])(
  'U5: CLI accept reuses real node cache without caller Python settings; cache=%s',
  async cache => {
    process.env.BUN_OPTIONS =
      `${process.env.BUN_OPTIONS ?? ''} --preload=${directAuxiliaryPreload()}`.trim();
    const s = stub([]),
      repo = gitRepo(s.root),
      counter = join(s.root, 'executions');
    const plan = JSON.parse(readFileSync(fixturePlan(s.root, repo), 'utf8')) as Plan;
    plan.packages = [plan.packages[0]!];
    plan.packages[0]!.accept = [{ cmd: `echo executed >> '${counter}'`, timeout_s: 5, cache }];
    const gen = generate(plan, 'sa1', true);
    s.ledger.gen_dir = gen.dir;
    s.ledger.repo = repo;
    writeFileSync(ledgerPath('sa1'), JSON.stringify(s.ledger));
    const art = join(s.root, 'home/artifacts/runs/r');
    mkdirSync(art, { recursive: true });
    const contracts = JSON.parse(
      readFileSync(join(gen.dir, 'accept-inputs.json'), 'utf8')
    ) as Record<string, string>[];
    const contract = contracts.find(c => c.tag === 'diff-m1-r1')!;
    const head = sh('git rev-parse HEAD', repo).trim();
    const output = {
      head,
      reviewed_head: head,
      diff_hash: 'previous',
      status: 'done',
      error_class: null,
      needs: [],
    };
    const producerIds = new Set(
      Object.values(contract)
        .map(v => parseWholeOutputRef(v)?.nodeId)
        .filter((id): id is string => !!id)
    );
    const authority = {
      ...run('completed', { working_path: repo, output_root: join(s.root, 'home') }),
      user_message: '',
      metadata: {},
      events: [...producerIds].map(step_name => ({
        step_name,
        event_type: 'node_completed',
        data: { node_output: JSON.stringify(output), structured_output: output },
      })),
    };
    writeFileSync(join(s.dir, 'get-000.json'), JSON.stringify(authority));
    const resolved = await resolveAcceptanceContext(authority, [contract], art);
    const warm = Bun.spawnSync([process.execPath, join(gen.dir, '.archon/scripts/sa-check.ts')], {
      cwd: repo,
      env: {
        ...process.env,
        ...acceptanceNodeEnvironment(art, contract.tag!),
        ...Object.fromEntries(
          Object.entries(resolved.inputs[0]!).map(([k, v]) => [`INPUTS_${k.toUpperCase()}`, v])
        ),
        INPUTS_EVENTS_FILE: resolved.events_file,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(warm.exitCode, warm.stderr.toString()).toBe(0);
    expect(readFileSync(counter, 'utf8')).toBe('executed\n');
    const result = captured(() => main(['accept', 'sa1']));
    expect(result.code, result.out).toBe(0);
    expect(readFileSync(counter, 'utf8')).toBe(cache ? 'executed\n' : 'executed\nexecuted\n');
  }
);

test.each([
  [1, 'inputs'],
  [2, 'artifact'],
  [3, 'strict'],
  [3, 'risk'],
  [1, 'environment'],
  [2, 'classification'],
  [3, 'new-debt'],
  [1, 'missing-environment'],
] as const)(
  'generated CLI acceptance and land preserve only approved non-product debt R%i %s',
  (round, check) => {
    // check:1b1504b9cd7d70de: watchdog supervision is covered by ACCT tests.
    process.env.BUN_OPTIONS =
      `${process.env.BUN_OPTIONS ?? ''} --preload=${directAuxiliaryPreload()}`.trim();
    const s = stub([]),
      targetRepo = gitRepo(s.root),
      wt = join(s.root, 'code-worker');
    sh('git branch -m wetamp', targetRepo);
    const delivery = captureDelivery(targetRepo);
    const plan = JSON.parse(readFileSync(fixturePlan(s.root, targetRepo), 'utf8')) as Plan;
    plan.base_ref = 'wetamp';
    plan.packages = [plan.packages[0]!];
    plan.environment = [{ cmd: 'true', timeout_s: 5 }];
    const marker = join(s.root, 'home', 'failure.json');
    writeFileSync(
      marker,
      JSON.stringify({ failure_class: 'baseline', evidence: 'fixture baseline' })
    );
    const command = `cat '${marker}'; exit 1`,
      newFailure = join(s.root, 'home', 'new-failure');
    plan.packages[0]!.accept = [
      { cmd: command, timeout_s: 5, cache: false },
      {
        cmd: `test ! -f '${newFailure}' || { printf '%s\\n' '{"failure_class":"fixture","evidence":"new debt"}'; exit 1; }`,
        timeout_s: 5,
        cache: false,
      },
    ];
    const gen = generate(plan, 'sa1', true);
    s.ledger.gen_dir = gen.dir;
    s.ledger.repo = targetRepo;
    s.ledger.delivery = delivery;
    writeFileSync(ledgerPath('sa1'), JSON.stringify(s.ledger));
    sh(`git worktree add -qb sa/sa1 '${wt}'`, targetRepo);
    sh(
      'echo change > core.txt && git add core.txt && git -c user.name=t -c user.email=t@l commit -qm change',
      wt
    );
    const head = sh('git rev-parse HEAD', wt).trim(),
      base = sh('git rev-parse wetamp', wt).trim();
    const art = join(s.root, 'home', 'artifacts', 'runs', 'r');
    mkdirSync(art, { recursive: true });
    writeFileSync(
      join(s.dir, 'get-000.json'),
      JSON.stringify(
        run('completed', {
          working_path: wt,
          output_root: join(s.root, 'home'),
          nodes: [{ nodeId: 'land', state: 'completed' }],
        })
      )
    );
    const contracts = JSON.parse(
      readFileSync(join(gen.dir, 'accept-inputs.json'), 'utf8')
    ) as Record<string, string>[];
    const input = contracts.find(c => c.tag.startsWith('diff-') && c.tag.endsWith(`-r${round}`))!;
    const producerOutput = {
      head: base,
      reviewed_head: base,
      diff_hash: 'previous',
      status: 'done',
      error_class: null,
      needs: [],
    };
    const producerIds = new Set(
      contracts.flatMap(c =>
        Object.values(c)
          .map(v => parseWholeOutputRef(v)?.nodeId)
          .filter((id): id is string => !!id)
      )
    );
    const authority = {
      ...run('completed', {
        working_path: wt,
        output_root: join(s.root, 'home'),
        nodes: [{ nodeId: 'land', state: 'completed' }],
      }),
      events: [...producerIds].map(step_name => ({
        step_name,
        event_type: 'node_completed',
        data: { node_output: JSON.stringify(producerOutput), structured_output: producerOutput },
      })),
    };
    const saveAuthority = () =>
      writeFileSync(join(s.dir, 'get-000.json'), JSON.stringify(authority));
    saveAuthority();
    const start = input.base.slice(1).split('.')[0]!;
    writeFileSync(join(art, `${start}.json`), JSON.stringify({ head: base }));
    const execute = () => {
      const p = Bun.spawnSync([process.execPath, join(gen.dir, '.archon/scripts/sa-check.ts')], {
        cwd: wt,
        env: {
          ...process.env,
          ...Object.fromEntries(
            Object.entries(input).map(([k, v]) => [`INPUTS_${k.toUpperCase()}`, v])
          ),
          INPUTS_BASE: base,
          INPUTS_PREV: 'previous',
          INPUTS_CODER: JSON.stringify(producerOutput),
          INPUTS_DELTA_BASE: base,
          ARTIFACTS_DIR: art,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect({
        code: p.exitCode,
        stderr: p.stderr.toString(),
        out: archonMod.lastJson(p.stdout.toString()),
      }).toMatchObject({ code: 0 });
      return archonMod.lastJson(p.stdout.toString())!;
    };
    const first = execute(),
      gate = input.tag.replace('diff-', 'gate-');
    writeFileSync(join(art, `${gate}.json`), JSON.stringify({ decision: first.decision }));
    writeFileSync(
      join(art, `${gate}.review.json`),
      JSON.stringify({ status: 'PASS', findings: [], debt: [] })
    );
    writeFileSync(
      join(art, 'land.json'),
      JSON.stringify({ repo: wt, target: 'main', branch: 'sa/sa1', head })
    );
    const queriesBefore = s.calls().filter(c => c.startsWith('workflow get r')).length;
    expect(captured(() => main(['accept', 'sa1'])).code).toBe(0);
    expect(s.calls().filter(c => c.startsWith('workflow get r')).length - queriesBefore).toBe(1);
    if (check === 'inputs') {
      const missing = round > 1 ? `gate-${input.milestone}-r${round - 1}` : start;
      const savedEvents = authority.events;
      authority.events = savedEvents.filter(e => e.step_name !== missing);
      saveAuthority();
      expect(() => main(['accept', 'sa1'])).toThrow(/input resolution failed/);
      authority.events = savedEvents;
      saveAuthority();
    }
    if (check === 'artifact') {
      writeFileSync(
        join(art, `${input.tag}.json`),
        JSON.stringify({ ...first, failures: undefined })
      );
      expect(captured(() => main(['accept', 'sa1'])).code).toBe(1);
      writeFileSync(join(art, `${input.tag}.json`), JSON.stringify(first));
      expect(captured(() => main(['accept', 'sa1', '--pkg', 'core'])).code).toBe(1);
      expect(() => main(['accept', 'sa1', '--pkg', 'nope'])).toThrow(/unknown package/);
    }
    if (check === 'strict') {
      writeFileSync(join(gen.dir, 'plan.json'), JSON.stringify({ ...plan, mode: 'strict' }));
      expect(captured(() => main(['accept', 'sa1'])).code).toBe(1);
      writeFileSync(join(gen.dir, 'plan.json'), JSON.stringify(plan));
    }
    if (check === 'risk') {
      input.risk = 'G2';
      writeFileSync(join(gen.dir, 'accept-inputs.json'), JSON.stringify([input]));
      expect(captured(() => main(['accept', 'sa1'])).code).toBe(1);
      input.risk = 'G1';
      writeFileSync(join(gen.dir, 'accept-inputs.json'), JSON.stringify(contracts));
    }
    if (check === 'environment') {
      process.env.SA_LAND_ENV_DRIFT = 'changed';
      try {
        expect(captured(() => main(['accept', 'sa1'])).code).toBe(1);
      } finally {
        delete process.env.SA_LAND_ENV_DRIFT;
      }
    }
    if (check === 'classification') {
      for (const classification of ['product', 'unknown']) {
        writeFileSync(
          marker,
          JSON.stringify({ failure_class: classification, evidence: 'new failure' })
        );
        expect(captured(() => main(['accept', 'sa1'])).code).toBe(1);
      }
      writeFileSync(
        marker,
        JSON.stringify({ failure_class: 'baseline', evidence: 'fixture baseline' })
      );
    }
    if (check === 'new-debt') {
      writeFileSync(newFailure, 'new');
      expect(captured(() => main(['accept', 'sa1'])).code).toBe(1);
      rmSync(newFailure);
    }
    if (check === 'missing-environment') {
      writeFileSync(join(gen.dir, 'plan.json'), JSON.stringify({ ...plan, environment: [] }));
      expect(captured(() => main(['accept', 'sa1'])).code).toBe(1);
      writeFileSync(join(gen.dir, 'plan.json'), JSON.stringify(plan));
    }
    expect(captured(() => main(['land', 'sa1', '--apply'])).code).toBe(0);
    expect(sh('git rev-parse wetamp^{tree}', wt)).toBe(sh('git rev-parse sa/sa1^{tree}', wt));
    if (check === 'inputs') {
      writeFileSync(
        join(gen.dir, 'plan.json'),
        JSON.stringify({
          ...plan,
          packages: [{ ...plan.packages[0]!, accept: [{ cmd: 'true', timeout_s: 5 }] }],
        })
      );
      expect(captured(() => main(['accept', 'sa1', '--pkg', 'core'])).code).toBe(0);
    }
  },
  // Repeated real accept/land passes each launch 10s-bounded Git watchdogs; allow
  // their cumulative time under load without changing the individual limits.
  60_000
);

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
  test('configured mobile transport leaves existing Reminders untouched and exposes unsupported gates', () => {
    const s = stub([humanWait()]);
    mkdirSync(join(s.root, 'home/console'), { recursive: true });
    writeFileSync(join(s.root, 'home/console/decision-origin'), 'https://private.example.test');
    const calls = supervisor(s.root, 'yes');
    expect(cliMod.superviseTick()).toMatchObject({
      actions: [{ transport: 'mobile', held: true, ok: false }],
    });
    expect(calls()).toEqual([]);
  });

  const tick = (): Record<string, unknown>[] => {
    const { code, out } = captured(() => main(['supervise-tick']));
    expect(code).toBe(0);
    return JSON.parse(out).actions as Record<string, unknown>[];
  };
  test('ORCA1 sync runs after tick and its failure preserves both tick exit codes', async () => {
    for (const failed of [false, true]) {
      const s = stub([humanWait()]);
      if (failed) writeFileSync(join(s.root, 'home', 'asks.json'), '{');
      const out = spyOn(console, 'log').mockImplementation(() => undefined);
      const err = spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const baseline = await superviseTickCli(
          async () => undefined,
          async () => undefined
        );
        for (const returned of [false, true]) {
          const printed = out.mock.calls.length;
          const exit = await superviseTickCli(
            async () => undefined,
            async () => {
              expect(out.mock.calls.length).toBe(printed + 1);
              if (!failed)
                expect(readFileSync(join(s.root, 'home', 'asks.json'), 'utf8')).toContain(
                  'pending'
                );
              if (returned) return { error: 'injected\nreason' };
              throw new Error('injected\nreason');
            }
          );
          expect(exit).toBe(baseline);
          expect(exit).toBe(failed ? 1 : 0);
          expect(String(err.mock.calls.at(-1)?.[0])).toBe(
            'supervise-tick: orca sync failed: injected reason'
          );
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
          await superviseTickCli(() => {
            throw new Error(message);
          })
        ).toBe(failed ? 1 : 0);
        const result = JSON.parse(String(out.mock.calls[0]?.[0]));
        expect(result.console_error).toBe(message);
        expect(result.actions[0]).toMatchObject({ action: failed ? 'error' : 'ask', ok: !failed });
        expect(String(err.mock.calls[0]?.[0])).toBe(
          'supervise-tick: console refresh failed: refresh injected original error'
        );
        expect(await eventually(s.calls, 'workflow wake r --json')).toBeDefined();
      } finally {
        out.mockRestore();
        err.mockRestore();
      }
      expect(s.calls()).not.toContain('workflow wake --json');
    });
  }
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
    expect(result.console_error).toBe(
      'console owner ambiguous; legacy PID migration refused: argv'
    );
    expect(err.trim()).toBe(`supervise-tick: console refresh failed: ${result.console_error}`);
    expect(result.actions[0]).toMatchObject({ action: 'ask', ok: true });
    expect(await eventually(s.calls, 'workflow wake r --json')).toBeDefined();
    expect(s.calls()).not.toContain('workflow wake --json');
  });
  test('held:human: asks once, then approves on yes (signal) and wakes due waits', async () => {
    const s = stub([humanWait(), humanWait(), run('running')]);
    const sup = supervisor(s.root, 'yes');
    expect(tick()).toEqual([
      {
        run_id: 'sa1',
        event: 'sa.human.m2',
        action: 'ask',
        ok: true,
        ask: 'ask-1',
        controller: s.ledger.controller,
        generation: s.ledger.controller!.generation,
      },
    ]);
    expect(sup()[0]).toMatch(
      /^ask --question .*human-m2.*等待人工签收.*是=批准签收门.*否=终止整个run.* --ttl-hours 72 --context-json .*$/
    );
    expect(tick()[0]).toMatchObject({ action: 'approve', ok: true });
    expect(await eventually(s.calls, 'workflow signal r --event sa.human.m2')).toBeDefined();
    expect(await eventually(s.calls, 'workflow wake r --json')).toBeDefined();
    expect(sup()).toEqual([
      expect.stringMatching(/^ask /),
      'ask-status ask-1',
      expect.stringMatching(/^ask-ack .*"stage":"received"/),
      expect.stringMatching(/^ask-ack .*"stage":"executing"/),
    ]);
    expect(s.calls()).not.toContain('workflow wake --json');
  });
  test('pending keeps waiting; no abandons the paused run', () => {
    const s = stub([humanWait()]);
    supervisor(s.root, 'pending');
    tick();
    expect(tick()[0]).toMatchObject({ action: 'none', ask: 'pending' });
    writeFileSync(join(s.root, 'answer'), 'no');
    expect(tick()[0]).toMatchObject({ action: 'reject', ok: true });
    expect(s.calls()).toContain('workflow abandon r --json');
  });
  for (const answer of ['yes', 'no'])
    test(`HF9 old unknown signoff reconciles ${answer} without creating a reminder`, async () => {
      const s = stub(answer === 'yes' ? [humanWait(), run('running')] : [humanWait()]),
        sup = supervisor(s.root, answer),
        key = 'sa1:signoff:39d592de14436296';
      const state = join(s.root, 'sv-state', 'asks');
      mkdirSync(state, { recursive: true });
      writeFileSync(
        join(state, 'old.json'),
        JSON.stringify({ id: 'old-signoff', question: `superagent ${key} 红线签收：批准合入 x？` })
      );
      writeFileSync(
        join(s.root, 'home', 'asks.json'),
        JSON.stringify({ [key]: { status: 'unknown' } })
      );
      expect(tick()[0]).toMatchObject({
        action: answer === 'yes' ? 'approve' : 'reject',
        ok: true,
      });
      expect(sup().filter(c => !c.startsWith('ask-ack '))).toEqual(['ask-status old-signoff']);
      expect(
        await eventually(
          s.calls,
          answer === 'yes' ? 'workflow signal r --event sa.human.m2' : 'workflow abandon r --json'
        )
      ).toBeDefined();
    });
  test('ttl follows the wait deadline (≥1h)', () => {
    const s = stub([humanWait(new Date(Date.now() + 5 * 3600e3).toISOString())]);
    const sup = supervisor(s.root, 'pending');
    tick();
    expect(sup()[0]).toContain('--ttl-hours 5 --context-json ');
  });
  test('same episode retains its question when only the resume deadline changes', () => {
    const s = stub([humanWait('2099-01-01T00:00:00.000Z'), humanWait('2099-02-01T00:00:00.000Z')]);
    const sup = supervisor(s.root, 'pending');
    tick();
    expect(tick()[0]).toMatchObject({ action: 'none', ask: 'pending' });
    expect(sup().filter(c => c.startsWith('ask '))).toHaveLength(1);
    const asks = JSON.parse(readFileSync(join(s.root, 'home', 'asks.json'), 'utf8')) as object;
    expect(Object.keys(asks)).toEqual(['sa1:signoff:39d592de14436296']);
  });
  test('asks of runs without a ledger (gc.sh removed it) are dropped on write-back', () => {
    const s = stub([humanWait()]);
    supervisor(s.root, 'pending');
    const p = join(s.root, 'home', 'asks.json');
    writeFileSync(p, JSON.stringify({ 'gone:m1:0': { id: 'x', status: 'pending' } }));
    tick();
    expect(Object.keys(JSON.parse(readFileSync(p, 'utf8')) as object)).toEqual([
      'sa1:signoff:39d592de14436296',
    ]);
  });
  test('the ledger holds an unknown entry before supervisor ask runs; an id-less entry with no supervisor record is re-asked', () => {
    const s = stub([humanWait()]);
    const py = join(s.root, 'sup-snap.py');
    writeFileSync(
      py,
      `import os, shutil, sys\nshutil.copy('${s.root}/home/asks.json', '${s.root}/at-ask.json')\nprint('ask-1')\n`
    );
    process.env.SA_SUPERVISOR = py;
    tick();
    expect(JSON.parse(readFileSync(join(s.root, 'at-ask.json'), 'utf8'))).toMatchObject({
      'sa1:signoff:39d592de14436296': { status: 'unknown', context: { task_id: 'sa1' } },
    });
    // 模拟上次 tick 在 ask 期间死掉且 supervisor 没有落下记录：重投
    writeFileSync(
      join(s.root, 'home', 'asks.json'),
      '{"sa1:signoff:39d592de14436296":{"status":"unknown"}}'
    );
    rmSync(join(s.root, 'at-ask.json'));
    expect(tick()[0]).toMatchObject({ action: 'ask', ok: true, ask: 'ask-1' });
    expect(existsSync(join(s.root, 'at-ask.json'))).toBe(true);
  });
  test('an ask that saved its record then exited non-zero stays unknown; the next tick reconciles via ask-status instead of asking again', () => {
    const s = stub([humanWait()]);
    const sup = supervisor(s.root, 'pending');
    const state = join(s.root, 'sv-state', 'asks');
    // 桩 ask：像 supervisor create() 一样先落记录，再在投递阶段失败
    writeFileSync(
      join(s.root, 'supervisor.py'),
      `import json, os, sys\nd = os.path.dirname(os.path.abspath(__file__))\nopen(os.path.join(d, 'sup-calls'), 'a').write(' '.join(sys.argv[1:]) + '\\n')\nif sys.argv[1] == 'ask':\n    os.makedirs('${state}', exist_ok=True)\n    json.dump({'id': 'abc', 'question': sys.argv[3], 'status': 'pending'}, open('${state}/abc.json', 'w'))\n    sys.exit(3)\nprint(open(os.path.join(d, 'answer')).read().strip())\n`
    );
    expect(captured(() => main(['supervise-tick'])).code).toBe(1);
    const asks = (): unknown => JSON.parse(readFileSync(join(s.root, 'home', 'asks.json'), 'utf8'));
    expect(asks()).toMatchObject({ 'sa1:signoff:39d592de14436296': { status: 'unknown' } });
    expect(tick()[0]).toMatchObject({ action: 'none', ok: true, ask: 'pending' });
    expect(sup().filter(c => c.startsWith('ask '))).toHaveLength(1);
    expect(sup().at(-1)).toBe('ask-status abc');
    expect(asks()).toMatchObject({
      'sa1:signoff:39d592de14436296': { id: 'abc', status: 'pending' },
    });
  });
  test('a held supervise.lock makes a concurrent tick skip with exit 0 and touch nothing', () => {
    const s = stub([humanWait()]);
    supervisor(s.root, 'pending');
    const held = archonMod.lock(join(s.root, 'home', 'supervise.lock'));
    if (!held.ok) throw new Error('lock not taken');
    const { code, out } = captured(() => main(['supervise-tick']));
    held.release();
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ skipped: 'locked' });
    expect(s.calls()).toEqual([]);
    expect(tick()[0]).toMatchObject({ action: 'ask', ok: true });
  });
  test('held:human past the plan deadline: tick cancels (reason deadline), ask expired, supervisor untouched, brief says so', () => {
    const s = stub([humanWait()]);
    supervisor(s.root, 'yes');
    writeFileSync(
      join(s.root, 'gen', 'plan.json'),
      JSON.stringify({ deadline: '2020-01-01T00:00:00Z', packages: [{ id: 'core' }] })
    );
    writeFileSync(
      join(s.root, 'home', 'asks.json'),
      JSON.stringify({ 'sa1:signoff:39d592de14436296': { id: 'ask-1', status: 'pending' } })
    );
    expect(tick()).toEqual([
      {
        run_id: 'sa1',
        event: 'sa.human.m2',
        action: 'cancel',
        ok: true,
        reason: 'deadline',
        controller: s.ledger.controller,
        generation: s.ledger.controller!.generation,
      },
    ]);
    expect(s.calls()).toContain('workflow abandon r --json');
    expect(existsSync(join(s.root, 'sup-calls'))).toBe(false);
    expect(JSON.parse(readFileSync(join(s.root, 'home', 'asks.json'), 'utf8'))).toEqual({
      'sa1:signoff:39d592de14436296': { id: 'ask-1', status: 'expired' },
    });
    expect(loadLedger('sa1')).toMatchObject({ state: 'failed', reason: 'deadline' });
    const lines = captured(() => main(['brief', 'sa1'])).out.split('\n');
    expect(lines).toContain('plan 截止已过，已取消');
    expect(lines).toContain('ask sa1:signoff:39d592de14436296: expired');
  });
  test('a yes that arrives after the plan deadline passed is not signalled: the run is abandoned and the ask expired', () => {
    const s = stub([humanWait()]);
    const plan = join(s.root, 'gen', 'plan.json');
    writeFileSync(
      plan,
      JSON.stringify({ deadline: '2099-01-01T00:00:00Z', packages: [{ id: 'core' }] })
    );
    writeFileSync(
      join(s.root, 'home', 'asks.json'),
      JSON.stringify({ 'sa1:signoff:39d592de14436296': { id: 'ask-1', status: 'pending' } })
    );
    // 桩 ask-status：截止恰在用户答“是”的期间过去
    const py = join(s.root, 'sup-late.py');
    writeFileSync(
      py,
      `import json\njson.dump({'deadline': '2020-01-01T00:00:00Z', 'packages': [{'id': 'core'}]}, open('${plan}', 'w'))\nprint('yes')\n`
    );
    process.env.SA_SUPERVISOR = py;
    expect(tick()).toEqual([
      {
        run_id: 'sa1',
        event: 'sa.human.m2',
        action: 'cancel',
        ok: true,
        reason: 'deadline',
        controller: s.ledger.controller,
        generation: s.ledger.controller!.generation,
      },
    ]);
    expect(s.calls().some(c => c.startsWith('workflow signal'))).toBe(false);
    expect(s.calls()).toContain('workflow abandon r --json');
    expect(JSON.parse(readFileSync(join(s.root, 'home', 'asks.json'), 'utf8'))).toEqual({
      'sa1:signoff:39d592de14436296': { id: 'ask-1', status: 'expired' },
    });
    expect(loadLedger('sa1')).toMatchObject({ state: 'failed', reason: 'deadline' });
  });
  test('held:human before the plan deadline still asks; nothing is cancelled', () => {
    const s = stub([humanWait()]);
    supervisor(s.root, 'pending');
    writeFileSync(
      join(s.root, 'gen', 'plan.json'),
      JSON.stringify({ deadline: '2099-01-01T00:00:00Z', packages: [{ id: 'core' }] })
    );
    expect(tick()[0]).toMatchObject({ action: 'ask', ok: true });
    expect(s.calls().some(c => /^workflow (cancel|abandon)/.test(c))).toBe(false);
    expect(loadLedger('sa1').reason).toBeUndefined();
  });
  test('a null or malformed supervisor ask record is skipped and counted; the valid one is still reconciled', () => {
    const s = stub([humanWait()]);
    const sup = supervisor(s.root, 'pending');
    const state = join(s.root, 'sv-state', 'asks');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'a-null.json'), 'null');
    writeFileSync(join(state, 'b-bad.json'), '{"id":');
    writeFileSync(
      join(state, 'c-ok.json'),
      JSON.stringify({
        id: 'abc',
        question: 'superagent sa1:signoff:39d592de14436296 红线签收：批准合入 x？',
      })
    );
    writeFileSync(
      join(s.root, 'home', 'asks.json'),
      '{"sa1:signoff:39d592de14436296":{"status":"unknown"}}'
    );
    expect(tick()[0]).toMatchObject({
      action: 'none',
      ok: true,
      ask: 'pending',
      reason: '2 anomalous ask records',
    });
    expect(sup()).toEqual(['ask-status abc']);
  });
});

describe('RCPT consumed decision receipts', () => {
  const tick = (code = 0): Record<string, unknown>[] => {
    const result = captured(() => main(['supervise-tick']));
    expect(result.code, JSON.stringify(JSON.parse(result.out).actions)).toBe(code);
    return JSON.parse(result.out).actions;
  };
  const asks = (
    root: string
  ): Record<
    string,
    {
      status: string;
      receipt: {
        key: string;
        body: string;
        at?: string;
        delivery?: string;
        error?: string;
        stage?: string;
        effect?: object;
      };
    }
  > => JSON.parse(readFileSync(join(root, 'home', 'asks.json'), 'utf8'));
  const body = (root: string): string => Object.values(asks(root))[0].receipt.body;

  test('efficiency context: one bound request, full fields and marker, no repeated ask', () => {
    const s = stub([humanWait()]),
      sup = supervisor(s.root, 'pending');
    tick();
    tick();
    const calls = sup().filter(c => c.startsWith('ask '));
    expect(calls).toHaveLength(1);
    const context = JSON.parse(calls[0].split(' --context-json ')[1]);
    expect(context).toMatchObject({
      source: 'superagent',
      task_id: 'sa1',
      initiator: 'unknown',
      action: 'approve',
      target: expect.stringContaining(':r:human-m2'),
      recommendation: { choice: 'no', reason: expect.any(String) },
      consequences: { yes: expect.stringContaining('批准'), no: expect.stringContaining('终止') },
    });
    expect(context.request_key).toBe(Object.keys(asks(s.root))[0]);
    const question = /^ask --question (.*) --ttl-hours/.exec(calls[0])![1];
    expect(Array.from(question).length).toBeLessThanOrEqual(200);
    expect(question).toMatch(/；\[sa:[a-f0-9]{32}\]$/);
  });

  test('efficiency delivery failure retries same receipt without replay; actual failed execution never succeeds', () => {
    const s = stub([humanWait()]),
      sup = supervisor(s.root, 'yes');
    tick();
    const signal = spyOn(archonMod, 'signalHuman').mockReturnValue({ ok: true, pid: 0, log: '' });
    const fail = spyOn(cliMod, 'supervisor').mockImplementation(args => {
      if (args[0] === 'ask-ack') throw new Error('fixture delivery unavailable');
      return supervisorTransport(args);
    });
    try {
      tick();
    } finally {
      fail.mockRestore();
    }
    const first = Object.values(asks(s.root))[0].receipt;
    expect(first).toMatchObject({ delivery: 'failed', stage: 'executing' });
    tick();
    expect(Object.values(asks(s.root))[0].receipt).toMatchObject({
      key: first.key,
      delivery: 'sent',
    });
    writeFileSync(
      join(s.dir, 'get-000.json'),
      JSON.stringify(run('failed', { completed_at: new Date().toISOString() }))
    );
    tick();
    tick();
    expect(Object.values(asks(s.root))[0].receipt).toMatchObject({
      stage: 'failed',
      delivery: 'sent',
    });
    const receipts = sup()
      .filter(c => c.startsWith('ask-ack '))
      .map(c => JSON.parse(c.split(' --receipt-json ')[1]));
    expect(receipts.map(r => r.stage)).toEqual(['executing', 'failed']);
    expect(receipts[0].key).toBe(first.key);
    expect(signal).toHaveBeenCalledTimes(1);
    signal.mockRestore();
    expect(sup().filter(c => c.startsWith('ask '))).toHaveLength(1);
  });

  test('R1 received is delivered before the effect; failed executing delivery cannot suppress terminal', () => {
    const s = stub([humanWait()]),
      sup = supervisor(s.root, 'yes');
    tick();
    const signal = spyOn(archonMod, 'signalHuman').mockImplementation(() => {
      expect(sup().some(c => c.includes('"stage":"received"'))).toBe(true);
      return { ok: true, pid: 0, log: '' };
    });
    const fail = spyOn(cliMod, 'supervisor').mockImplementation(args => {
      if (args[0] === 'ask-ack' && args.at(-1)?.includes('"stage":"executing"'))
        throw new Error('fixture executing notification unavailable');
      return supervisorTransport(args);
    });
    try {
      tick();
      expect(Object.values(asks(s.root))[0].receipt).toMatchObject({
        stage: 'executing',
        delivery: 'failed',
      });
      writeFileSync(
        join(s.dir, 'get-000.json'),
        JSON.stringify(run('completed', { completed_at: new Date().toISOString() }))
      );
      tick();
      tick();
      expect(Object.values(asks(s.root))[0].receipt).toMatchObject({
        stage: 'succeeded',
        delivery: 'sent',
      });
      expect(signal).toHaveBeenCalledTimes(1);
      expect(sup().filter(c => c.includes('"stage":"succeeded"'))).toHaveLength(1);
    } finally {
      fail.mockRestore();
      signal.mockRestore();
    }
  });

  test.each(['failed', 'completed'] as const)(
    'efficiency adopted execution %s owns the outcome; stale source failure is ignored',
    status => {
      const s = stub([run('failed')]);
      supervisor(s.root, 'pending');
      const key = 'sa1:budget:fixture';
      writeFileSync(
        join(s.root, 'home/asks.json'),
        JSON.stringify({
          [key]: {
            id: 'ask-1',
            status: 'approved',
            receipt: {
              key: 'bound',
              stage: 'executing',
              delivery: 'sent',
              body: '已提交新run',
              terminal_before: 'r:failed:',
              effect: { action: 'adopt', engine_run: 'r2' },
            },
          },
        })
      );
      writeFileSync(join(s.dir, 'get-000.json'), JSON.stringify(run(status, { id: 'r2' })));
      tick();
      expect(Object.values(asks(s.root))[0].receipt.stage).toBe(
        status === 'completed' ? 'succeeded' : 'failed'
      );
      expect(s.calls().some(c => c.startsWith('workflow get r2 '))).toBe(true);
      const saved = asks(s.root);
      saved[key].receipt = {
        key: 'same',
        stage: 'executing',
        delivery: 'sent',
        body: '受理',
        ...{ terminal_before: 'r:failed:' },
        effect: { action: 'resume', engine_run: 'r' },
      };
      writeFileSync(join(s.root, 'home/asks.json'), JSON.stringify(saved));
      writeFileSync(join(s.dir, 'get-000.json'), JSON.stringify(run('failed')));
      tick();
      expect(Object.values(asks(s.root))[0].receipt.stage).toBe('executing');
    }
  );

  for (const answer of ['yes', 'no'] as const)
    test(`RCPT checked/deleted ${answer}: one receipt, no new decision or replay`, () => {
      const s = stub(answer === 'yes' ? [humanWait(), humanWait(), run('running')] : [humanWait()]);
      const sup = supervisor(s.root, answer);
      tick();
      expect(tick()[0]).toMatchObject({
        action: answer === 'yes' ? 'approve' : 'reject',
        ok: true,
      });
      const expected = `run=sa1；节点=human-m2；答复=${answer === 'yes' ? '是；已批准等待门并提交续跑' : '否；已终止整个run（保留证据）'}；去向=r；结果=动作已受理（不代表后续验收通过）`;
      expect(body(s.root)).toBe(expected);
      const receipt = Object.values(asks(s.root))[0];
      expect(receipt).toMatchObject({
        status: answer === 'yes' ? 'approved' : 'rejected',
        receipt: { body: expected, at: expect.any(String) },
      });
      expect(receipt.receipt.delivery).toBe('sent');
      expect(receipt.receipt.key).toMatch(/^[a-f0-9]{64}$/);
      expect(captured(() => main(['brief', 'sa1'])).out.split('\n')).toContain(
        `receipt: ${expected}`
      );
      expect(JSON.parse(captured(() => main(['status', 'sa1'])).out).receipt).toBe(expected);
      tick();
      tick();
      expect(sup().filter(c => c.startsWith('ask '))).toHaveLength(1);
      expect(sup().filter(c => c.startsWith('ask-status '))).toHaveLength(1);
      expect(sup().filter(c => c.startsWith('notify '))).toHaveLength(0);
      expect(
        s
          .calls()
          .filter(c => c.startsWith(answer === 'yes' ? 'workflow signal ' : 'workflow abandon '))
      ).toHaveLength(1);
    });

  for (const delivery of ['pending', 'failed'] as const)
    test(`RCPT legacy ${delivery} receipt stays readable after terminal state without notification or replay`, () => {
      const s = stub([humanWait()]),
        sup = supervisor(s.root, 'no');
      tick();
      tick();
      const saved = asks(s.root),
        receipt = Object.values(saved)[0].receipt;
      delete receipt.at;
      delete receipt.stage;
      delete receipt.effect;
      receipt.delivery = delivery;
      if (delivery === 'failed') receipt.error = "invalid choice: 'notify'";
      writeFileSync(join(s.root, 'home', 'asks.json'), JSON.stringify(saved));
      writeFileSync(join(s.dir, 'get-000.json'), JSON.stringify(run('cancelled')));
      tick();
      tick();
      expect(asks(s.root)).toEqual(saved);
      expect(captured(() => main(['brief', 'sa1'])).out).toContain(`receipt: ${receipt.body}`);
      expect(JSON.parse(captured(() => main(['status', 'sa1'])).out).receipt).toBe(receipt.body);
      expect(sup().filter(c => c.startsWith('notify '))).toHaveLength(0);
      expect(s.calls().filter(c => c.startsWith('workflow abandon '))).toHaveLength(1);
    });

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

  test('RCPT unconfirmed effect is explicit and never replayed', () => {
    const s = stub([humanWait()]),
      sup = supervisor(s.root, 'no');
    tick();
    const original = archonMod.archonJson;
    const fail = spyOn(archonMod, 'archonJson').mockImplementation((a, cwd) =>
      a[1] === 'abandon' ? { ok: false } : original(a, cwd)
    );
    try {
      expect(tick(1)[0]).toMatchObject({ action: 'reject', ok: false });
    } finally {
      fail.mockRestore();
    }
    expect(Object.values(asks(s.root))[0]).toMatchObject({
      status: 'no',
      decision: { answer: 'no', engine_run: 'r' },
    });
    expect(tick(1)[0]).toMatchObject({
      action: 'decision_reconcile',
      ok: false,
      error: expect.stringContaining('decision_effect_unknown'),
    });
    expect(sup().filter(c => c.startsWith('notify '))).toHaveLength(0);
    expect(s.calls().filter(c => c.startsWith('workflow abandon '))).toHaveLength(0);
  });

  test('RCPT exit after cancellation before consumption is reconciled from terminal engine state', () => {
    const s = stub([humanWait()]),
      sup = supervisor(s.root, 'no');
    tick();
    const script = join(s.root, 'crash.ts');
    writeFileSync(
      script,
      `import {spyOn} from 'bun:test';
import * as config from ${JSON.stringify(join(WETAMP, 'src/config.ts'))};
import {main} from ${JSON.stringify(join(WETAMP, 'src/cli.ts'))};
const original=config.writeAtomic;
spyOn(config,'writeAtomic').mockImplementation((path,body)=>{
  if(path.endsWith('/asks.json') && body.includes('"action": "reject"')) process.exit(73);
  return original(path,body);
});
process.exit(main(['supervise-tick']));`
    );
    // The fake engine persists cancellation before acknowledging it, independently of asks.json.
    fixtureOptions(s.dir, { persistCancellation: true });
    const child = Bun.spawnSync([process.execPath, script], {
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 5000,
    });
    expect(child.exitCode, child.stderr.toString()).toBe(73);
    expect(Object.values(asks(s.root))[0]).toMatchObject({
      status: 'no',
      decision: { answer: 'no', engine_run: 'r' },
    });
    expect(Object.values(asks(s.root))[0]).not.toHaveProperty('decision.effect');
    expect(Object.values(asks(s.root))[0].receipt.stage).toBe('received');
    expect(tick()[0]).toMatchObject({ action: 'receipt_reconciled', ok: true });
    expect(body(s.root)).toContain('已终止整个run');
    expect(Object.values(asks(s.root))[0]).toMatchObject({
      status: 'rejected',
      receipt: { body: expect.stringContaining('已终止整个run') },
    });
    tick();
    expect(sup().filter(c => c.startsWith('notify '))).toHaveLength(0);
    expect(s.calls().filter(c => c.startsWith('workflow abandon '))).toHaveLength(1);
  });

  for (const sample of ['approval'] as string[])
    test(`RCPT actual ${sample} action uses engine facts and excludes output prose`, () => {
      const s = stub([]);
      const plan = JSON.parse(readFileSync(fixturePlan(s.root, s.root), 'utf8')) as Plan;
      const gen = generate(plan, 'sa1', true);
      Object.assign(s.ledger, {
        gen_dir: gen.dir,
        workflow_hash: sample === 'adopt' ? 'old' : engineHash(),
      });
      writeFileSync(ledgerPath('sa1'), JSON.stringify(s.ledger));
      const node =
        sample === 'milestone'
          ? 'gate-m1-r3'
          : sample === 'approval'
            ? 'approval-m1'
            : 'verify-core';
      const art = join(s.root, 'out/artifacts/runs/r');
      mkdirSync(art, { recursive: true });
      const dirty = 'synthetic-secret arbitrary model output';
      const reason = 'budget_launches_exceeded';
      writeFileSync(
        join(art, `${node}.json`),
        JSON.stringify({
          decision: { kind: 'block', reason, evidence: [], debt: [] },
          summary: dirty,
          rounds: 3,
        })
      );
      const r = run(sample === 'approval' ? 'paused' : 'failed', {
        output_root: join(s.root, 'out'),
        nodes: [{ nodeId: node, state: 'failed' }],
        ...(sample === 'approval'
          ? { metadata: { approval: { nodeId: node, type: 'merge_review' } } }
          : {}),
      });
      writeFileSync(join(s.dir, 'get-000.json'), JSON.stringify({ ...r, events: [] }));
      supervisor(s.root, 'yes');
      expect(tick()[0].action).toBe('ask');
      expect(tick()[0].ok).toBe(true);
      const expected = {
        package: '已提交包core编码→验收重跑',
        milestone: '已提交里程碑m1累计验收→评审重跑',
        adopt: '已新开run从首个节点重跑',
        approval: '已批准等待门并提交续跑',
      }[sample];
      expect(body(s.root)).toContain(expected!);
      expect(body(s.root)).toContain(`去向=${sample === 'adopt' ? 'r2' : 'r'}`);
      expect(body(s.root)).not.toContain(dirty);
      if (sample === 'adopt') expect(s.calls().some(c => c.includes('--adopt r'))).toBe(true);
      if (sample === 'package')
        expect(readFileSync(join(gen.dir, 'attempts/.packages/core'), 'utf8')).toBe('1');
      if (sample === 'milestone')
        expect(readFileSync(join(gen.dir, 'attempts/m1'), 'utf8')).toBe('1');
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
      expect(out.reason).toStartWith('coder:');
      expect(out.delivery).toContainEqual({ tag: 'verify-core', decision: result.decision });
      expect(out.delivery[0].decision).toMatchObject({ reason: 'coder_partial', blockers, needs });
    }
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
        decision: saCheck.deliveryDecision({ rechecks: [{ ok: true, diff_hash: '', same: false }] })
          .decision,
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

  const asksFile = (): string => join(process.env.SUPERAGENT_HOME ?? '', 'asks.json');
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
  test('E1 real settle incidents become engine_suspect and save one sample, never coder failure', () => {
    const fixtures = JSON.parse(
      readFileSync(join(import.meta.dir, 'incidents/e1-settle.json'), 'utf8')
    ) as { node: string; verify: object; settle: object; coder: object }[];
    for (const f of fixtures) {
      const s = held(f.node, {
        'verify-core.json': f.verify,
        'settle-core.json': f.settle,
        'settle-core.coder.json': f.coder,
      });
      const sup = supervisor(s.root, 'pending');
      const r = JSON.parse(readFileSync(join(s.dir, 'get-000.json'), 'utf8')) as RunView;
      expect(classifyRun(s.ledger, r).state).toBe('held:engine_suspect');
      expect(tick()[0]).toMatchObject({
        action: 'none',
        held: true,
        reason: expect.stringContaining('engine_suspect'),
      });
      expect(tick()[0]).toMatchObject({ action: 'none' });
      expect(sup().filter(c => c.startsWith('ask '))).toHaveLength(0);
      expect(resumes(s.calls())).toBe(0);
      expect(existsSync(join(s.root, 'home/incidents/sa1/sample.json'))).toBe(true);
    }
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
  test('E2 one episode asks once; unbound legacy questions are archived before a fresh ask', () => {
    const f = JSON.parse(readFileSync(join(import.meta.dir, 'incidents/e2-asks.json'), 'utf8')) as {
      attempts: number[];
      hold: string;
    };
    const s = held('code-core');
    setGet(s.root, run('paused', { metadata: { approval: { nodeId: 'code-core' } } }));
    const sup = supervisor(s.root, 'pending');
    for (const attempt of f.attempts) {
      const l = loadLedger('sa1');
      l.auto_retries = [{ milestone: 'm1', reason: 'coder:code-core', at: '2020-01-01T00:00:00Z' }];
      l.recoveries = Array.from({ length: attempt }, () => '2020-01-01T00:00:00Z');
      writeFileSync(ledgerPath('sa1'), JSON.stringify(l));
      tick();
    }
    expect(sup().filter(c => c.startsWith('ask '))).toHaveLength(1);
    const key = askKey('sa1', 'approval', 'code-core@');
    const a = JSON.parse(readFileSync(asksFile(), 'utf8'))[key];
    const legacy = `${key}:2`;
    writeFileSync(asksFile(), JSON.stringify({ [legacy]: { status: 'unknown' } }));
    const records = join(s.root, 'sv-state/asks');
    mkdirSync(records, { recursive: true });
    writeFileSync(
      join(records, 'record.json'),
      JSON.stringify({ id: a.id, question: `superagent ${legacy} fixture` })
    );
    expect(tick()[0]).toMatchObject({ action: 'ask' });
    expect(sup().filter(c => c.startsWith('ask '))).toHaveLength(2);
    expect(JSON.parse(readFileSync(asksFile(), 'utf8'))[legacy].status).toBe('superseded');
  });
  test.each(['yes', 'no'])(
    'I3 completed run refuses decide and resume/adopt; late %s is superseded and counted stale',
    answer => {
      const s = held('x');
      setGet(s.root, run('paused', { metadata: { approval: { nodeId: 'approval-m1' } } }));
      tick();
      setGet(s.root, run('completed'));
      supervisor(s.root, answer);
      const before = readFileSync(ledgerPath('sa1'), 'utf8');
      for (const action of ['retry', 'reject', 'approve']) {
        const r = captured(() => main(['decide', 'sa1', action]));
        expect(r.code).toBe(1);
        expect(JSON.parse(r.out).reason).toContain('completed');
      }
      patchLedger(s.root, { engine_hash: 'old' });
      const stale = readFileSync(ledgerPath('sa1'), 'utf8');
      expect(captured(() => main(['resume', 'sa1'])).code).toBe(1);
      expect(readFileSync(ledgerPath('sa1'), 'utf8')).toBe(stale);
      expect(before).not.toBe(stale);
      const result = captured(() => main(['supervise-tick']));
      expect(JSON.parse(result.out)).toMatchObject({
        actions: [],
        stale_answer: 1,
        orphan_hold: 0,
      });
      expect(
        JSON.parse(readFileSync(asksFile(), 'utf8'))[askKey('sa1', 'approval', 'approval-m1@')]
          .status
      ).toBe('superseded');
      expect(s.calls().filter(c => /workflow (resume|run|cancel|abandon)/.test(c))).toEqual([]);
    }
  );
  test('I4 id-less superseded legacy answer is reconciled read-only and counted once', () => {
    const s = held('code-core');
    setGet(s.root, run('completed'));
    const sup = supervisor(s.root, 'no');
    const key = 'sa1:auto_retry_exhausted:2';
    writeFileSync(asksFile(), JSON.stringify({ [key]: { status: 'unknown' } }));
    const records = join(s.root, 'sv-state/asks');
    mkdirSync(records, { recursive: true });
    writeFileSync(
      join(records, 'late.json'),
      JSON.stringify({ id: 'late', question: `superagent ${key} fixture` })
    );
    const result = JSON.parse(captured(() => main(['supervise-tick'])).out);
    expect(result).toMatchObject({ actions: [], stale_answer: 1 });
    expect(JSON.parse(readFileSync(asksFile(), 'utf8'))[key]).toMatchObject({
      status: 'superseded',
      id: 'late',
      stale_answer: true,
    });
    expect(sup().filter(c => c.startsWith('ask '))).toEqual([]);
    expect(resumes(s.calls())).toBe(0);
  });
  test('only a recorded permission decision surfaces a current need', () => {
    const s = held('gate-m1-r1', { 'gate-m1-r1.json': gate('coder_redline') });
    expect(tick()).toEqual([]);
    const status = JSON.parse(captured(() => main(['status', 'sa1'])).out);
    expect(status.needs).toMatchObject([{ tag: 'gate-m1-r1', cap: 'permission' }]);
    expect(captured(() => main(['brief', 'sa1'])).out).toContain('need permission');
    expect(resumes(s.calls())).toBe(0);
  });
  test('held gate ignores needs from advanced nodes when retrying', () => {
    const need = { cap: 'approval', why: 'obsolete', minimal_ask: 'check process deviation' };
    const s = held('gate-m1-r1', {
      'gate-m1-r1.json': gate('invalid_review'),
      'verify-core.json': { ok: true, disposition: 'advance' },
      'verify-core.coder.json': {
        status: 'blocked',
        error_class: 'redline',
        needs: [need],
        milestone: 'm1',
      },
    });
    const archive = join(s.art, 'verify-core.coder.json');
    const original = readFileSync(archive, 'utf8');
    const sup = supervisor(s.root, 'pending');
    expect(tick()).toEqual([]);
    expect(resumes(s.calls())).toBe(0);
    expect(sup().filter(c => c.startsWith('ask '))).toHaveLength(0);
    expect(captured(() => main(['brief', 'sa1'])).out).not.toContain(
      'need approval (verify-core): check process deviation'
    );
    expect(JSON.parse(captured(() => main(['status', 'sa1'])).out).needs).toBeUndefined();
    expect(readFileSync(archive, 'utf8')).toBe(original);
  });
  test.each(['acceptance_failed', 'invalid_review'])(
    'held gate %s keeps its structured reason despite a coder redline self-report',
    reason => {
      const s = held('gate-m1-r1', {
        'gate-m1-r1.json': gate(reason),
        'verify-core.coder.json': {
          status: 'blocked',
          error_class: 'redline',
          error_class_ignored: true,
          needs: [],
          milestone: 'm1',
        },
      });
      supervisor(s.root, 'pending');
      expect(tick()).toEqual([]);
    }
  );
  test('terminal gate decisions refuse retry without changing attempts', () => {
    const s = held('gate-m1-r6', { 'gate-m1-r6.json': gate('review_failed+review_limit') });
    expect(captured(() => main(['decide', 'sa1', 'retry'])).code).toBe(1);
    expect(existsSync(join(s.root, 'gen', 'attempts', 'm1'))).toBe(false);
    expect(resumes(s.calls())).toBe(0);
  });

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
  const yesCall: Record<string, string> = {
    review: 'workflow resume r --detach --json',
    retry: 'workflow resume r --detach --json',
    resume: 'workflow resume r --detach --json',
    approve: 'workflow approve r --detach --json',
    adjudicate: 'workflow run sa-sa1',
  };

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

  for (const [hold, p] of Object.entries(HOLD_POLICY) as [Hold, Policy][]) {
    if (p.do === 'resume') continue;
    if (p.do !== 'ask') {
      test(`HOLD_POLICY ${hold} → ${p.do}, no reminder`, () => {
        const { s, first } = scenes[hold]();
        const sup = supervisor(s.root, 'pending');
        const actions = tick();
        if (!actions.length) {
          expect(
            classifyRun(s.ledger, JSON.parse(readFileSync(join(s.dir, 'get-000.json'), 'utf8')))
              .state
          ).toBe('failed');
          expect(sup()).toEqual([]);
          expect(resumes(s.calls())).toBe(0);
          return;
        }
        const x = actions[0];
        expect(x).toMatchObject({ run_id: 'sa1', ...first });
        // 签收门本身就是提问；其余自动处置不投提醒
        if (hold !== 'signoff') expect(sup()).toEqual([]);
        if (p.do === 'blocked') {
          expect(x).toMatchObject({
            action: 'none',
            held: true,
            next: expect.stringContaining('superagent brief'),
          });
          tick();
          expect(sup()).toEqual([]);
          expect(
            s.calls().filter(c => /^workflow (resume|run|approve|signal|abandon) /.test(c))
          ).toHaveLength(0);
          expect(captured(() => main(['brief', 'sa1'])).out).toContain('next:');
          expect(loadLedger('sa1').dispositions).toHaveLength(1);
          expect(loadLedger('sa1').dispositions![0]).toMatchObject({
            action: 'blocked',
            ok: false,
            error: x.next,
          });
          return;
        }
        expect(loadLedger('sa1').dispositions?.at(-1)).toMatchObject({
          reason: hold,
          action: x.action,
          ok: true,
        });
        if (hold === 'deadline') {
          expect(s.calls()).toContain('workflow abandon r --json');
          expect(loadLedger('sa1')).toMatchObject({ state: 'failed', reason: 'deadline' });
          expect(loadLedger('sa1').intervention_events?.at(-1)).toMatchObject({
            action: 'cancel',
            reason: 'deadline',
            ok: true,
          });
        }
      });
      continue;
    }
    test(`HOLD_POLICY ${hold} → ask once (≤200 chars); yes runs ${p.yes}, no ends the run`, () => {
      const { s } = scenes[hold]();
      const sup = supervisor(s.root, 'pending');
      expect(tick()[0]).toMatchObject({
        run_id: 'sa1',
        action: 'ask',
        reason: hold,
        ok: true,
        ask: 'ask-1',
      });
      const q = /^ask --question (.*) --ttl-hours \d+ --context-json /.exec(sup()[0])?.[1] ?? '';
      expect(q).toMatch(/；\[sa:[a-f0-9]{32}\]$/);
      expect(Array.from(q).length).toBeLessThanOrEqual(200);
      expect(q).toContain('是=');
      expect(tick()[0]).toMatchObject({ action: 'none', reason: hold, ask: 'pending' });
      expect(sup().filter(c => c.startsWith('ask '))).toHaveLength(1);
      // 旧版本已投递但本地只落 unknown：仍按原 key 找回，不能重复投递。
      const oldKey = Object.keys(JSON.parse(readFileSync(asksFile(), 'utf8')))[0];
      const records = join(s.root, 'sv-state', 'asks');
      mkdirSync(records, { recursive: true });
      writeFileSync(
        join(records, 'old.json'),
        JSON.stringify({ id: 'old-pending', question: `superagent ${oldKey} 旧模板` })
      );
      writeFileSync(asksFile(), JSON.stringify({ [oldKey]: { status: 'unknown' } }));
      writeFileSync(join(s.root, 'answer'), 'yes');
      const before = s.calls().length;
      expect(tick()[0]).toMatchObject({ action: p.yes, reason: hold, ok: true });
      expect(
        s
          .calls()
          .slice(before)
          .some(call => call.startsWith(yesCall[p.yes]))
      ).toBe(true);
      expect(
        sup()
          .filter(c => c.startsWith('ask-status '))
          .at(-1)
      ).toBe('ask-status old-pending');
      expect(sup().filter(c => c.startsWith('notify '))).toHaveLength(0);
      expect(sup().filter(c => c.startsWith('ask '))).toHaveLength(1);
      expect(loadLedger('sa1').dispositions?.map(d => `${d.reason}/${d.action}`)).toEqual([
        `${hold}/ask`,
        `${hold}/${p.yes}`,
      ]);
      const n = scenes[hold]();
      supervisor(n.s.root, 'no');
      tick();
      const noKey = Object.keys(JSON.parse(readFileSync(asksFile(), 'utf8')))[0];
      const noRecords = join(n.s.root, 'sv-state', 'asks');
      mkdirSync(noRecords, { recursive: true });
      writeFileSync(
        join(noRecords, 'old.json'),
        JSON.stringify({ id: 'old-no', question: `superagent ${noKey} 旧模板` })
      );
      writeFileSync(asksFile(), JSON.stringify({ [noKey]: { status: 'unknown' } }));
      expect(tick()[0]).toMatchObject({ action: 'reject', reason: hold, ok: true });
      expect(n.s.calls().some(c => /^workflow (cancel|abandon) r/.test(c))).toBe(true);
    });
  }

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
  } // Real sa-check subprocess rounds take ~5-10s; the 5s default flakes under load.
  test('non-independent review stays blocked until a qualified reviewer is configured', () => {
    const { s } = scenes.review_not_independent();
    const sup = supervisor(s.root, 'yes');
    tick();
    tick();
    expect(sup()).toEqual([]);
    expect(existsSync(join(s.root, 'gen', 'attempts', 'review-m1-r1'))).toBe(false);
    expect(resumes(s.calls())).toBe(0);
  });

  test('a corrupt ledger reports action:error; the other run is still handled and report counts it unreadable', () => {
    const s = held('environment');
    supervisor(s.root, 'pending');
    writeFileSync(join(s.root, 'home', 'runs', 'bad.json'), '{"run_id": "bad", trunc');
    writeFileSync(join(s.root, 'home', 'runs', 'odd.json'), JSON.stringify({ run_id: 'other' }));
    const { code, out: text } = captured(() => main(['supervise-tick']));
    expect(code).toBe(1);
    const out = JSON.parse(text).actions as Record<string, unknown>[];
    expect(out.find(x => x.run_id === 'sa1')).toMatchObject({
      action: 'none',
      held: true,
      ok: true,
    });
    expect(out.find(x => x.run_id === 'bad')).toMatchObject({ action: 'error', ok: false });
    expect(out.find(x => x.run_id === 'odd')).toMatchObject({ action: 'error', ok: false });
    expect(readFileSync(join(s.root, 'home', 'runs', 'bad.json'), 'utf8')).toBe(
      '{"run_id": "bad", trunc'
    );
    const rep = captured(() => main(['report', '--full']));
    expect(rep.code).toBe(1);
    expect(JSON.parse(rep.out)).toMatchObject({
      runs: 3,
      unreadable: [
        expect.stringMatching(/^bad: ledger .*JSON Parse error/),
        expect.stringMatching(/^odd: .*run_id/),
      ],
    });
  });
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
  test('HF9 missing/corrupt display evidence does not prevent delivery', () => {
    const { s, r, art, put } = setup();
    put('code-W4.json', { reason: 'coder_redline' });
    r.nodes = [{ nodeId: 'code-W4', state: 'failed' }];
    rmSync(join(art, 'verify-W4.coder.json'));
    writeFileSync(join(s.dir, 'get-000.json'), JSON.stringify(r));
    const sup = supervisor(s.root, 'pending');
    expect(captured(() => main(['supervise-tick'])).code).toBe(0);
    expect(sup()).toEqual([]);
    writeFileSync(join(art, 'verify-W4.coder.json'), '{');
    expect(decisionQuestion(s.ledger, r, classify(r), 'needs')).toContain('补齐明确能力或输入');
  });
  test('HF9 R3 free text never reaches the supervisor title, even for unknown reasons and enums', () => {
    const dirty =
      'rg "synthetic-needle" src/a.ts; echo synthetic-value; DB_URL: postgres://demo:synthetic-pass@host.invalid/db';
    for (const hold of (
      ['redline', 'needs', 'signoff', 'approval', 'review_limit'] as const
    ).filter(h => ['signoff', 'approval'].includes(h))) {
      const { s, r, put } = setup();
      const node =
        hold === 'signoff' ? 'human-m1' : hold === 'review_limit' ? 'gate-m1-r3' : 'verify-W4';
      put(`${node}.json`, { reason: dirty, summary: dirty, rounds: 3, failed: [dirty] });
      put('verify-W4.coder.json', {
        milestone: 'm1',
        error_class: dirty,
        blockers: [dirty],
        summary: dirty,
        needs: [{ cap: dirty, why: dirty, minimal_ask: dirty }],
      });
      put('gate-m1-r3.json', { reason: dirty, verdict: dirty, summary: dirty, rounds: 3 });
      put('gate-m1-r3.ledger.json', { blocking: [{ id: dirty, evidence: dirty }] });
      if (hold === 'signoff') {
        r.status = 'paused';
        r.metadata = {
          wait: {
            nodeId: node,
            kind: 'event',
            event: 'sa.human.m1',
            resumeAt: '2099-01-01T00:00:00Z',
          },
        };
      } else if (hold === 'approval') {
        r.status = 'paused';
        r.metadata = { approval: { nodeId: node, type: dirty } };
      } else {
        // Drive a registered hold; all supplementary free text remains deliberately hostile.
        put('verify-W4.json', {
          reason: hold === 'needs' ? 'coder_needs' : 'coder_redline',
          summary: dirty,
        });
        if (hold === 'review_limit') {
          r.nodes = [{ nodeId: node, state: 'failed' }];
          put(`${node}.json`, {
            verdict: 'escalate',
            reason: 'coder_redline+review_limit',
            rounds: 3,
            summary: dirty,
          });
        }
      }
      writeFileSync(join(s.dir, 'get-000.json'), JSON.stringify(r));
      const sup = supervisor(s.root, 'pending');
      expect(captured(() => main(['supervise-tick'])).code).toBe(0);
      const q = /^ask --question (.*) --ttl-hours/.exec(sup()[0])![1];
      for (const fragment of [
        'rg',
        'synthetic-needle',
        'src/a.ts',
        'echo',
        'synthetic-value',
        'DB_URL',
        'postgres',
        'demo',
        'synthetic-pass',
        'host.invalid',
        '/db',
      ])
        expect(q).not.toContain(fragment);
      expect(q).toContain('详情superagent brief <run>');
      expect(q).toContain('是=');
      expect(q).toContain('否=终止整个run');
      const unregistered = decisionQuestion(s.ledger, r, { state: 'failed', exit: 1, node }, hold);
      expect(unregistered).not.toContain(dirty);
    }
  });
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
  const maximumTitle = (hold: Hold, value = Number.MAX_SAFE_INTEGER) => {
    const f = setup(),
      { s, r } = f;
    const repo = join(s.root, 'R'.repeat(255));
    mkdirSync(repo);
    cpSync(s.ledger.gen_dir, join(repo, 'gen'), { recursive: true });
    cpSync(join(s.ledger.repo, 'out'), join(repo, 'out'), { recursive: true });
    r.output_root = join(repo, 'out');
    const put = (file: string, data: unknown): void =>
      writeFileSync(join(repo, 'out/artifacts/runs/r', file), JSON.stringify(artifact(file, data)));
    Object.assign(s.ledger, {
      repo,
      gen_dir: join(repo, 'gen'),
      engine_hash: 'old-engine',
      stalled: value,
    });
    writeFileSync(ledgerPath('sa1'), JSON.stringify(s.ledger));
    const plan = JSON.parse(readFileSync(join(s.ledger.gen_dir, 'plan.json'), 'utf8')) as Plan;
    const m = 'M'.repeat(32);
    plan.budget = { launches: value, weighted_tokens: value };
    plan.packages = Array.from({ length: 4 }, (_, i) => ({
      ...plan.packages[0],
      id: `W${String(i)}`.padEnd(64, 'x'),
      milestone: m,
      title: '长标题'.repeat(1000),
    }));
    writeFileSync(join(s.ledger.gen_dir, 'plan.json'), JSON.stringify(plan));
    const review = hold === 'review_limit' || hold === 'review_not_independent';
    const node =
      hold === 'signoff' ? `human-${m}` : review ? `gate-${m}-r3` : `verify-${plan.packages[3].id}`;
    writeFileSync(
      join(s.ledger.gen_dir, '.archon/workflows/sa-sa1/sa-sa1.yaml'),
      `nodes:\n  - id: attempt-${m}\n  - id: attempt-review-${m}-r3\n` +
        [...plan.packages.slice(0, 3).map(p => `settle-${p.id}`), node]
          .map(id => `  - id: ${id}\n`)
          .join('')
    );
    r.nodes = [
      ...plan.packages.slice(0, 3).map(p => ({ nodeId: `settle-${p.id}`, state: 'completed' })),
      { nodeId: node, state: 'failed' },
    ];
    const reasons: Partial<Record<Hold, string>> = {
      needs: 'coder_needs',
      redline: 'coder_redline',
      coder_blocked: 'coder_error:sandbox_denied',
      review_limit: 'review_failed+review_limit',
      review_not_independent: 'review_not_independent:same_model',
    };
    put(`${node}.json`, { reason: reasons[hold] ?? hold, rounds: value, verdict: 'escalate' });
    put(`${node}.ledger.json`, { blocking: [{ id: 'R1' }] });
    put(`${node}.coder.json`, {
      milestone: m,
      needs: hold === 'needs' ? [{ cap: 'network', why: '', minimal_ask: '' }] : [],
    });
    if (hold === 'engine_suspect') {
      s.ledger.workflow_hash = engineHash();
      writeFileSync(ledgerPath('sa1'), JSON.stringify(s.ledger));
    }
    if (hold === 'signoff') {
      r.status = 'paused';
      r.metadata = {
        wait: {
          nodeId: node,
          kind: 'event',
          event: `sa.human.${m}`,
          resumeAt: '2099-01-01T00:00:00Z',
        },
      };
    } else if (hold === 'approval') {
      r.status = 'paused';
      r.metadata = { approval: { nodeId: node, type: 'merge_review' } };
    }
    writeFileSync(join(s.dir, 'get-000.json'), JSON.stringify({ ...r, events: [] }));
    return { ...f, node, value };
  };
  const assertBoundedTitle = (q: string, hold: Hold) => {
    const policy = HOLD_POLICY[hold];
    if (policy.do === 'blocked') {
      expect(q).toContain(policy.text);
      expect(q).toContain('superagent brief');
      expect(q).not.toContain('是=');
      return;
    }
    if (policy.do !== 'ask' && policy.do !== 'signoff') throw new Error('not an ask');
    expect(q).toContain(policy.text);
    expect(q).toContain('是=');
    expect(q).toContain('否=终止整个run（保留证据）');
    expect(q).toMatch(/；\[sa:[a-f0-9]{32}\]$/);
    expect(Array.from(q).length).toBeLessThanOrEqual(200);
  };
  for (const [hold, policy] of Object.entries(HOLD_POLICY) as [Hold, Policy][]) {
    if (policy.do !== 'ask' && policy.do !== 'signoff') continue;
    for (const value of [Number.MAX_SAFE_INTEGER, Number.MAX_VALUE])
      test(`HF9 R4 all HOLD_POLICY titles remain deliverable at numeric maximum: ${hold}/${String(value)}`, () => {
        const { s } = maximumTitle(hold, value);
        const usage = spyOn(saCheck, 'budgetUsage').mockReturnValue({
          launches: value,
          weighted_tokens: value,
          reserve: value,
        });
        try {
          const sup = supervisor(s.root, 'pending');
          const out = captured(() => main(['supervise-tick']));
          expect(out.code).toBe(0);
          expect(JSON.parse(out.out).actions[0]).toMatchObject({
            action: 'ask',
            ...(hold === 'signoff' ? {} : { reason: hold }),
          });
          const q =
            /^ask --question (.*) --ttl-hours \d+ --context-json /.exec(sup()[0])?.[1] ?? '';
          assertBoundedTitle(q, hold);
          const yes = /；是=(.+)；否=/.exec(q)?.[1] ?? '';
          expect(yes.length).toBeGreaterThan(0);
          if (policy.do === 'ask' && !['approve', 'adjudicate'].includes(policy.yes)) {
            if (hold !== 'engine_suspect')
              expect(yes).toContain('旧run身份未确认，将新开run从首个节点重跑');
            const target =
              /从[^；]+续跑一次|重跑[^；]+本轮评审一次|重跑[^；]+累计验收→评审一次/.exec(yes)?.[0];
            expect(target).toBeDefined();
            expect(yes).toContain(policy.yesText.replace('{target}', target!.replace(/一次$/, '')));
          } else expect(yes).toBe(policy.yesText);
        } finally {
          usage.mockRestore();
        }
      });
  }
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
  for (const hold of ['signoff'] as Hold[])
    for (const answer of ['pending', 'yes', 'no'] as const)
      test(`HF9 R2 existing ${hold}/${answer} skips title evidence and events query`, () => {
        const { s, r, put, art } = setup();
        if (hold === 'signoff') {
          r.status = 'paused';
          r.metadata = {
            wait: {
              nodeId: 'human-m1',
              kind: 'event',
              event: 'sa.human.m1',
              resumeAt: '2099-01-01T00:00:00Z',
            },
          };
        } else
          put('verify-W4.json', {
            reason: hold === 'redline' ? 'coder_redline' : 'budget_launches_exceeded',
          });
        writeFileSync(join(s.dir, 'get-000.json'), JSON.stringify({ ...r, events: [] }));
        const sup = supervisor(s.root, 'pending');
        expect(captured(() => main(['supervise-tick'])).code).toBe(0);
        const before = s.calls().filter(c => c.includes('--events')).length;
        writeFileSync(join(s.root, 'answer'), answer);
        // Suppress the answer's recovery/signal action; count only question-related I/O.
        const recovery = spyOn(archonMod, 'recover').mockReturnValue({
          ok: false,
          reason: 'test busy',
          busy: true,
        });
        const signal = spyOn(archonMod, 'signalHuman').mockReturnValue({
          ok: true,
          pid: 0,
          log: '',
        });
        const read = spyOn(fs, 'readFileSync');
        try {
          expect(captured(() => main(['supervise-tick'])).code).toBe(0);
          expect(
            read.mock.calls.filter(
              ([path]) =>
                String(path) === join(art, 'verify-W4.coder.json') ||
                String(path) === join(art, 'gate-m1-r3.json') ||
                String(path).endsWith('/budget-extra')
            )
          ).toHaveLength(0);
          expect(s.calls().filter(c => c.includes('--events')).length).toBe(before);
          expect(sup().filter(c => c.startsWith('ask --question'))).toHaveLength(1);
        } finally {
          read.mockRestore();
          signal.mockRestore();
          recovery.mockRestore();
        }
      });
  test('HF9 supervisor stub captures five R3 titles', () => {
    const samples: Record<string, string> = {};
    for (const sample of ['signoff'] as string[]) {
      const hold = sample === 'redline-adopt' ? 'redline' : sample;
      const { s, r, put, art } = bestIFA();
      if (sample === 'redline-adopt') {
        s.ledger.engine_hash = 'old-engine';
        writeFileSync(ledgerPath('sa1'), JSON.stringify(s.ledger));
      }
      if (hold === 'signoff') {
        r.status = 'paused';
        r.metadata = {
          wait: {
            nodeId: 'human-m1',
            kind: 'event',
            event: 'sa.human.m1',
            resumeAt: '2099-01-01T00:00:00Z',
          },
        };
      } else {
        put('verify-W4.json', {
          reason:
            hold === 'redline'
              ? 'coder_redline'
              : hold === 'needs'
                ? 'coder_needs'
                : 'budget_launches_exceeded',
        });
        if (hold === 'redline')
          put('verify-W4.coder.json', {
            milestone: 'm1',
            error_class: 'redline',
            blockers: ['只读检索命令被拒：无法确认shell写入目标（解析失败）'],
            needs: [],
          });
        if (hold === 'budget') rmSync(join(art, 'verify-W4.coder.json'));
      }
      writeFileSync(
        join(s.dir, 'get-000.json'),
        JSON.stringify({ ...r, events: [{ event_type: 'node_started', step_name: 'code-W4' }] })
      );
      const sup = supervisor(s.root, 'pending');
      expect(captured(() => main(['supervise-tick'])).code).toBe(0);
      samples[sample] =
        /^ask --question (.*) --ttl-hours \d+ --context-json /.exec(sup()[0])?.[1] ?? '';
      expect(samples[sample]).toContain('BestIFA');
      expect(samples[sample]).toContain('是=');
      expect(Array.from(samples[sample]).length).toBeLessThanOrEqual(200);
    }
    if (process.env.HF9_SAMPLES_OUT)
      writeFileSync(process.env.HF9_SAMPLES_OUT, JSON.stringify(samples, null, 2) + '\n');
  });
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
