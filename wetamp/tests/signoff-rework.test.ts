import { afterAll, expect, spyOn, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as coordination from '../src/coord';
import { lastJson } from '../src/archon';
import { generate } from '../src/generate';
import { WETAMP } from '../src/config';
import type { Plan } from '../src/plan';
import { fixtureEnv, fixturePlan, gitRepo, sh, stableInstall, tmp } from './helpers';

const fixtureEngine = gitRepo(tmp());
const engineBoundary = spyOn(coordination, 'cleanEngine').mockReturnValue(
  coordination.cleanEngine(fixtureEngine)
);

test('signoff rejection retries the target and later packages in the same run', () => {
  const root = tmp();
  const repo = gitRepo(root);
  const trace = join(root, 'code.trace');
  const scratchRoot = join(root, 'scratch');
  const preload = join(root, 'scratch-preload.cjs');
  writeFileSync(
    preload,
    `const path = require('node:path');
const scratch = require(${JSON.stringify(join(import.meta.dir, '..', 'hooks', 'scratch.cjs'))});
Object.assign(scratch, scratch.createScratch(${JSON.stringify(scratchRoot)}));
const original = { spawn: Bun.spawn, spawnSync: Bun.spawnSync };
for (const key of ['spawn', 'spawnSync']) Bun[key] = (cmd, options = {}) => {
  if (!Array.isArray(cmd)) { options = cmd; cmd = options.cmd; }
  if (['bun', 'node'].includes(path.basename(cmd[0]))) {
    const i = cmd[1] === 'run' ? 2 : cmd[2] === 'run' ? 3 : 1;
    cmd = [...cmd.slice(0, i), path.basename(cmd[0]) === 'bun' ? '--preload' : '--require', __filename, ...cmd.slice(i)];
  }
  return original[key](cmd, { ...options, env: { ...process.env, ...options.env } });
};`
  );

  const plan = JSON.parse(readFileSync(fixturePlan(root, repo), 'utf8')) as Plan;
  plan.packages = ['W1', 'W2', 'W3'].map((id, index) => ({
    ...plan.packages[0],
    id,
    title: id,
    goal: `Write ${id}.txt`,
    scope: { write: [`${id}.txt`] },
    deps: index === 0 ? [] : [`W${String(index)}`],
    accept: [{ cmd: `test -f ${id}.txt`, timeout_s: 10 }],
    risk: 'G1' as const,
    milestone: 'm1',
    review: index === 0,
    signoff: index === 2 ? ('human' as const) : undefined,
  }));

  const operatorHome = join(root, 'operator-home');
  const superagentHome = join(root, 'home');
  stableInstall(operatorHome);
  const env = fixtureEnv({
    HOME: operatorHome,
    SUPERAGENT_MEMORY: 'off',
    SUPERAGENT_RELAY_QUOTA: 'off',
    SUPERAGENT_HOME: superagentHome,
    ARCHON_HOME: join(superagentHome, 'archon'),
    SUPERAGENT_WRITE_ROOTS: root,
    SA_ARCHON_BIN: '',
    SA_SKIP_DOCTOR: '1',
  });
  const before = { ...process.env };
  let gen: ReturnType<typeof generate>;
  try {
    Object.assign(process.env, env);
    const install = Bun.spawnSync([join(WETAMP, 'scripts/install.sh')], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(install.exitCode, install.stderr.toString()).toBe(0);
    gen = generate(plan, 'signoff-rework', true);
  } finally {
    process.env = before;
  }

  const yaml = join(gen.dir, `.archon/workflows/${gen.workflow}/${gen.workflow}.yaml`);
  const workflow = Bun.YAML.parse(readFileSync(yaml, 'utf8')) as {
    nodes: { id: string; bash?: string }[];
  };
  for (const node of workflow.nodes)
    if (node.id.startsWith('code-'))
      node.bash = `echo '${node.id}' >> '${trace}'\n${node.bash ?? ''}`;
  writeFileSync(yaml, Bun.YAML.stringify(workflow));
  sh(
    `git add '.archon/workflows/${gen.workflow}/${gen.workflow}.yaml' && git -c user.name=sa -c user.email=sa@localhost commit -qm 'signoff fixture'`,
    gen.dir
  );

  const invoke = (entry: string, cwd: string, ...args: string[]) => {
    const child = Bun.spawnSync(
      [process.execPath, '--preload', preload, entry, ...args, '--json'],
      { env, cwd, stdout: 'pipe', stderr: 'pipe' }
    );
    return {
      code: child.exitCode,
      out: lastJson(child.stdout.toString()),
      err: child.stderr.toString(),
    };
  };
  const archon = (...args: string[]) =>
    invoke(join(WETAMP, 'src/coord/archon-entry.ts'), repo, ...args);
  const sa = (...args: string[]) => invoke(join(WETAMP, 'src/cli.ts'), repo, ...args);

  const launched = archon(
    'workflow',
    'run',
    gen.workflow,
    '--workflow-source',
    gen.dir,
    '--cwd',
    repo,
    '--branch',
    'sa/signoff-rework',
    '--from',
    'main',
    '--detach',
    '--config',
    gen.config
  );
  expect(launched.code, launched.err).toBe(0);
  const engineRun = String(launched.out?.runId);
  expect(archon('workflow', 'wait', engineRun, '--timeout', '120').code).toBe(0);

  const claimed = sa('claim', repo);
  expect(claimed.code, claimed.err).toBe(0);
  mkdirSync(join(superagentHome, 'runs'), { recursive: true });
  writeFileSync(
    join(superagentHome, 'runs/signoff-rework.json'),
    JSON.stringify({
      run_id: 'signoff-rework',
      archon_run_id: engineRun,
      engine_hash: gen.engine_hash,
      workflow_hash: gen.engine_hash,
      plan: join(gen.dir, 'plan.json'),
      gen_dir: gen.dir,
      repo,
      branch: 'sa/signoff-rework',
      workflow: gen.workflow,
      controller: claimed.out?.controller,
      console: 'claude',
      started_at: new Date().toISOString(),
      transcript: '',
      log: '',
      recoveries: [],
    })
  );

  expect(sa('wait', 'signoff-rework', '--timeout', '120').out).toMatchObject({
    state: 'held:human',
  });
  expect(readFileSync(trace, 'utf8').trim().split('\n')).toEqual(['code-W1', 'code-W2', 'code-W3']);

  const rejected = sa('decide', 'signoff-rework', 'reject', '--pkg', 'W2', '--hint', 'revise W2');
  expect(rejected.code, `${rejected.err}\n${JSON.stringify(rejected.out)}`).toBe(0);
  expect(sa('wait', 'signoff-rework', '--timeout', '120').out).toMatchObject({
    state: 'held:human',
  });
  expect(readFileSync(trace, 'utf8').trim().split('\n')).toEqual([
    'code-W1',
    'code-W2',
    'code-W3',
    'code-W2',
    'code-W3',
  ]);

  expect(sa('decide', 'signoff-rework', 'reject').code).toBe(0);
  expect(sa('status', 'signoff-rework').out).toMatchObject({ state: 'cancelled' });
}, 240_000);

afterAll(() => engineBoundary.mockRestore());
