import { afterEach, expect, test } from 'bun:test';
import { spyOn, afterAll } from 'bun:test';
import * as coordination from '../src/coord';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { lastJson } from '../src/archon';
import { generate } from '../src/generate';
import { WETAMP } from '../src/config';
import type { Plan } from '../src/plan';
import { fixturePlan, gitRepo, fixtureEnv, sh, stableInstall, tmp } from './helpers';
const fixtureEngine = gitRepo(tmp());
const originalCleanEngine = coordination.cleanEngine;
const engineBoundary = spyOn(coordination, 'cleanEngine').mockImplementation(() =>
  originalCleanEngine(fixtureEngine)
);

const scratchRoot = join(tmp(), 'scratch'),
  scratchPreload = join(tmp(), 'scratch-preload.cjs');
writeFileSync(
  scratchPreload,
  `const fs = require('node:fs'), path = require('node:path');
let violations = 0;
const check = value => {
  if (value instanceof URL) value = require('node:url').fileURLToPath(value);
  if (Buffer.isBuffer(value)) value = value.toString();
  if (typeof value !== 'string') return;
  const p = path.resolve(value);
  if (['/tmp/sa-scratch', '/private/tmp/sa-scratch'].some(r => p === r || p.startsWith(r + '/'))) {
    violations++; throw new Error('production scratch access: ' + p);
  }
};
const wrap = fn => function(...args) { args.forEach(check); return fn.apply(this, args); };
for (const api of [fs, fs.promises]) for (const key of Object.keys(api)) {
  if (typeof api[key] !== 'function' || /^[A-Z]/.test(key)) continue;
  const fn = api[key], native = fn.native;
  api[key] = wrap(fn);
  if (native) api[key].native = wrap(native);
}
require('node:module').syncBuiltinESMExports();
if (typeof Bun !== 'undefined') for (const key of ['spawn', 'spawnSync']) {
  const spawn = Bun[key]; Bun[key] = (cmd, options = {}) => {
    if (!Array.isArray(cmd)) { options = cmd; cmd = options.cmd; }
    if (['bun', 'node'].includes(path.basename(cmd[0]))) { const i = cmd[1] === 'run' ? 2 : cmd[2] === 'run' ? 3 : 1; cmd = [...cmd.slice(0, i), path.basename(cmd[0]) === 'bun' ? '--preload' : '--require', __filename, ...cmd.slice(i)]; }
    return spawn(cmd, {...options, env: {...process.env, ...options.env}});
  };
}
process.on('exit', () => { if (violations) process.exitCode = 1; });
const scratch = require(${JSON.stringify(join(import.meta.dir, '..', 'hooks', 'scratch.cjs'))});
const key = Symbol.for('superagent.test.scratch.default');
if (!globalThis[key]) {
  if (scratch.ROOT !== '/tmp/sa-scratch') throw new Error('production default changed');
  globalThis[key] = true;
}
if (scratch.ROOT !== ${JSON.stringify(scratchRoot)}) Object.assign(scratch, scratch.createScratch(${JSON.stringify(scratchRoot)}));
module.exports = {violations: () => violations};`
);
mkdirSync(join(scratchRoot, 'codex-sentinel'), { recursive: true });
writeFileSync(join(scratchRoot, 'codex-sentinel', 'keep'), 'isolated');
const originalSpawn = { spawn: Bun.spawn, spawnSync: Bun.spawnSync };
const boundary = createRequire(import.meta.url)(scratchPreload) as { violations: () => number };
afterEach(() => expect(boundary.violations()).toBe(0));

for (const scope of ['package', 'milestone'] as const)
  test(`HF10 ${scope} verification failure is terminal without an automatic retry ask`, () => {
    const root = tmp(),
      repo = gitRepo(root),
      ready = join(root, 'ready'),
      trace = join(root, 'code.trace');
    const plan = JSON.parse(readFileSync(fixturePlan(root, repo), 'utf8')) as Plan;
    plan.packages = Array.from({ length: 4 }, (_, i) => ({
      ...plan.packages[0],
      id: `W${i + 1}`,
      milestone: 'm1',
      scope: { write: [`W${i + 1}.txt`] },
      accept: [{ cmd: `test -f W${i + 1}.txt`, timeout_s: 5 }],
    }));
    if (scope === 'package')
      plan.packages[2].accept = [
        {
          cmd: `if test -f '${ready}'; then test -f W3.txt; else echo '{"failure_class":"test_env","evidence":"fixture not ready"}'; exit 1; fi`,
          timeout_s: 5,
        },
      ];
    // FC permits repair-limit debt in non-strict G1; this fixture exhausts the strict review rounds.
    if (scope === 'milestone') plan.mode = 'strict';
    const py = join(root, 'supervisor.py');
    writeFileSync(
      py,
      `import sys\nfrom pathlib import Path\np = Path(__file__).parent\nwith (p / 'questions').open('a') as f: f.write(' '.join(sys.argv[1:]) + '\\n')\nif sys.argv[1] not in ('ask', 'ask-status'): sys.exit(2)\nprint('ask-1' if sys.argv[1] == 'ask' else (p / 'answer').read_text())\n`
    );
    writeFileSync(join(root, 'answer'), 'pending');
    const home = join(root, 'operator-home');
    stableInstall(home);
    const env = {
      ...fixtureEnv(),
      HOME: home,
      SUPERAGENT_RELAY_QUOTA: 'off',
      SUPERAGENT_HOME: join(root, 'home'),
      ARCHON_HOME: join(root, 'home/archon'),
      SUPERAGENT_WRITE_ROOTS: root,
      SA_ARCHON_BIN: '',
      SA_SUPERVISOR: py,
      AGENT_SUPERVISOR_STATE: join(root, 'supervisor'),
      XDG_STATE_HOME: join(root, 'state'),
      SA_LAUNCHD_DIR: join(root, 'LaunchAgents'),
      SA_SKIP_DOCTOR: '1',
    };
    const before = { ...process.env };
    Object.assign(process.env, env);
    let gen: ReturnType<typeof generate>;
    try {
      expect(
        Bun.spawnSync([join(WETAMP, 'scripts/install.sh')], { env, stdout: 'pipe', stderr: 'pipe' })
          .exitCode
      ).toBe(0);
      gen = generate(plan, `hf10-${scope}`, true);
    } finally {
      process.env = before;
    }
    const yaml = join(gen.dir, `.archon/workflows/${gen.workflow}/${gen.workflow}.yaml`);
    const wf = Bun.YAML.parse(readFileSync(yaml, 'utf8')) as {
      nodes: { id: string; bash?: string; with?: Record<string, unknown> }[];
    };
    for (const node of wf.nodes) {
      if (node.id.startsWith('code-')) {
        node.bash = `echo '${node.id}' >> '${trace}'\n${node.bash}`;
      }
      if (scope === 'milestone' && /^review-m1-r[2-6]$/.test(node.id)) {
        const fail = {
          status: 'FAIL',
          notes: 'fixture',
          findings: [
            {
              id: 'R1-1',
              severity: 'high',
              file: 'fake',
              line: 1,
              status: 'open',
              evidence: 'fake',
              carry_over: true,
              failure_class: 'product',
              command: null,
            },
          ],
          fixture_confirmations: [],
          debt: [],
        };
        node.bash = `if test -f '${ready}'; then\n${node.bash}\nelse\necho '${JSON.stringify(fail)}'\nfi`;
      }
    }
    writeFileSync(yaml, Bun.YAML.stringify(wf));
    sh(
      `git add '.archon/workflows/${gen.workflow}/${gen.workflow}.yaml' && git -c user.name=sa -c user.email=sa@localhost commit -qm 'HF10 fixture'`,
      gen.dir
    );
    const sa = (...args: string[]) => {
      const p = Bun.spawnSync(
        [process.execPath, '--preload', scratchPreload, join(WETAMP, 'src/cli.ts'), ...args],
        {
          env,
          stdout: 'pipe',
          stderr: 'pipe',
        }
      );
      return { code: p.exitCode, out: lastJson(p.stdout.toString()), err: p.stderr.toString() };
    };
    const archon = (...args: string[]) => {
      const p = Bun.spawnSync(
        [
          process.execPath,
          '--preload',
          scratchPreload,
          join(WETAMP, 'src/coord/archon-entry.ts'),
          ...args,
          '--json',
        ],
        {
          env,
          cwd: repo,
          stdout: 'pipe',
          stderr: 'pipe',
        }
      );
      expect(p.exitCode).toBe(0);
      return lastJson(p.stdout.toString())!;
    };
    const id = `hf10-${scope}`,
      branch = `sa/${id}`;
    const ack = archon(
      'workflow',
      'run',
      gen.workflow,
      '--workflow-source',
      gen.dir,
      '--cwd',
      repo,
      '--branch',
      branch,
      '--from',
      'main',
      '--detach',
      '--config',
      gen.config
    );
    // Pending has no proven owner yet. Use the engine's launch/wait contract to
    // reach the fixture outcome before testing overlay retry policy.
    archon('workflow', 'wait', String(ack.runId), '--timeout', '120');
    const claim = sa('claim', repo);
    expect(claim.code).toBe(0);
    mkdirSync(join(env.SUPERAGENT_HOME, 'runs'), { recursive: true });
    writeFileSync(
      join(env.SUPERAGENT_HOME, `runs/${id}.json`),
      JSON.stringify({
        run_id: id,
        archon_run_id: ack.runId,
        engine_hash: 'old-ui-hash',
        workflow_hash: gen.engine_hash,
        plan: join(gen.dir, 'plan.json'),
        gen_dir: gen.dir,
        repo,
        branch,
        workflow: gen.workflow,
        controller: claim.out!.controller,
        console: 'claude',
        started_at: new Date().toISOString(),
        transcript: '',
        log: '',
        recoveries: [],
      })
    );
    const stopped = sa('wait', id, '--timeout', '120');
    expect(stopped.out).toMatchObject({
      state: 'failed',
      node: scope === 'package' ? 'settle-W3' : 'gate-m1-r6',
    });
    expect(readFileSync(trace, 'utf8').trim().split('\n')).toEqual([
      'code-W1',
      'code-W2',
      'code-W3',
      ...(scope === 'package' ? [] : ['code-W4']),
    ]);
    expect(sa('supervise-tick').out).toMatchObject({ actions: [] });
    expect(sa('decide', id, 'retry').code).toBe(1);
    expect(readFileSync(join(scratchRoot, 'codex-sentinel', 'keep'), 'utf8')).toBe('isolated');
    const ledger = JSON.parse(readFileSync(join(env.SUPERAGENT_HOME, `runs/${id}.json`), 'utf8'));
    expect(ledger.archon_run_id).toBe(ack.runId);
    expect(ledger.adoptions).toBeUndefined();
  }, 240000);

afterAll(() => {
  Object.assign(Bun, originalSpawn);
  engineBoundary.mockRestore();
});
