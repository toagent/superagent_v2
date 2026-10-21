import { afterAll, afterEach } from 'bun:test';
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildExecNodeEnvironment } from '../../packages/workflows/src/exec-environment';
import { newNodeInvocation, startNodeExecution } from '../../packages/workflows/src/node-execution';
import { removeTempTree } from '@archon/paths/test-utils';
import { loadTiers } from '../src/config';

const roots: string[] = [];
const children: Array<[ReturnType<typeof Bun.spawn>, boolean]> = [];

export function trackTestChild<T extends ReturnType<typeof Bun.spawn>>(
  proc: T,
  processGroup = false
): T {
  children.push([proc, processGroup]);
  return proc;
}

afterEach(async () => {
  for (const [proc, processGroup] of children.splice(0)) {
    try {
      process.kill(processGroup ? -proc.pid : proc.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    await proc.exited;
  }
});

afterAll(async () => {
  for (const r of roots.splice(0)) await removeTempTree(r);
  repoTemplate = undefined;
});

/** Fresh policy values, independent of the operator's routing and budget choices. */
export const fixtureTiers = () => loadTiers(join(import.meta.dir, 'fixtures/tiers.json'));

/** Only opted-in child processes see the fixture at the default tiers path. */
export const fixtureTiersEnv = () => ({
  BUN_OPTIONS:
    `${process.env.BUN_OPTIONS ?? ''} --preload=${join(import.meta.dir, 'fixtures/tiers-preload.cjs')}`.trim(),
});

/** Stable install shape, entirely under scratch HOME; no operator checkout or config. */
export function stableInstall(home: string): void {
  const install = join(home, 'stable-engine');
  mkdirSync(join(install, '.git'), { recursive: true });
  mkdirSync(join(install, 'wetamp/hooks'), { recursive: true });
  mkdirSync(join(install, 'wetamp/bin'), { recursive: true });
  writeFileSync(join(install, 'wetamp/hooks/git-guardrail.cjs'), 'module.exports = {};\n');
  writeFileSync(join(install, 'wetamp/bin/superagent'), '#!/bin/sh\nexit 0\n');
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  symlinkSync(join(install, 'wetamp/bin/superagent'), join(home, '.local/bin/superagent'));
}

export const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'sa-test-')));
  roots.push(d);
  return d;
};

/** Codex child fixtures route from a synthetic Codex controller, never the runner's ancestors. */
export function codexFixtureEnv(): { BUN_OPTIONS: string } {
  const preload = join(tmp(), 'launcher.cjs');
  writeFileSync(
    preload,
    `require(${JSON.stringify(join(import.meta.dir, '../hooks/live.cjs'))}).launcher = () => ({ client: 'codex', pid: process.pid, tty: null, cwd: process.cwd() });\n`
  );
  return { BUN_OPTIONS: `${process.env.BUN_OPTIONS ?? ''} --preload=${preload}`.trim() };
}

/** Semantic tests keep real commands/deadlines; ACCT tests own process-group supervision. */
export function directAuxiliaryPreload(): string {
  const preload = join(tmp(), 'direct-auxiliary.ts');
  writeFileSync(
    preload,
    `
const spawn = Bun.spawnSync;
Bun.spawnSync = (command, options) => {
  const args = Array.isArray(command) && command[0] === 'python3' && command[1] === '-c'
    ? command.slice(4) : command;
  return spawn(args, options);
};
`
  );
  return preload;
}

/** Tests inherit the preload-isolated environment; explicit role tests may override it. */
export const fixtureEnv = (env: Record<string, string> = {}) => ({
  ...process.env,
  ...env,
});

export const sh = (cmd: string, cwd: string, env: Record<string, string> = {}): string => {
  const p = Bun.spawnSync(['bash', '-c', cmd], {
    cwd,
    env: fixtureEnv(env),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (p.exitCode !== 0) throw new Error(`${cmd}: ${p.stderr.toString()}`);
  return p.stdout.toString();
};

/** main 分支上一个提交的 repo，外加 bare origin（--branch 需要 origin；不 push）。 */
let repoTemplate: string | undefined;
export function gitRepo(root: string): string {
  if (!repoTemplate) {
    const seed = tmp();
    sh(
      `git init -q -b main repo && echo hi > repo/README.md && git -C repo add README.md && git -C repo -c user.name=t -c user.email=t@l commit -qm init && git clone -q --bare repo origin.git && git -C repo remote add origin "${seed}/origin.git" && git -C repo fetch -q origin`,
      seed
    );
    repoTemplate = seed;
  }
  // Copy the read-only seed, including objects and refs: every caller owns all
  // mutable files and its origin; no shared worktrees or writable hard links.
  const repo = join(root, 'repo');
  cpSync(join(repoTemplate, 'repo'), repo, { recursive: true });
  cpSync(join(repoTemplate, 'origin.git'), join(root, 'origin.git'), { recursive: true });
  const config = join(repo, '.git/config');
  writeFileSync(
    config,
    readFileSync(config, 'utf8').replace(`${repoTemplate}/origin.git`, `${root}/origin.git`)
  );
  return repo;
}

export function fixturePlan(
  root: string,
  repo: string,
  patch: (p: Record<string, unknown>) => void = () => undefined
): string {
  const plan = JSON.parse(
    readFileSync(join(import.meta.dir, 'fixtures', 'plan-two-pkgs.json'), 'utf8')
  ) as Record<string, unknown>;
  plan.repo = repo;
  patch(plan);
  const p = join(root, 'plan.json');
  writeFileSync(p, JSON.stringify(plan));
  return p;
}

/** Real engine contract with a fresh invocation/attempt for each acceptance node. */
export function acceptanceNodeEnvironment(art: string, node: string): Record<string, string> {
  return buildExecNodeEnvironment({
    artifactsDir: art,
    stateDir: join(art, 'state'),
    logDir: join(art, node),
    workflowId: 'fixture',
    baseBranch: 'main',
    userMessage: 'fixture request',
    loopUserInput: '',
    loopPrevOutput: '',
    rejectionReason: '',
    typedArtifactsFile: join(art, `${node}.listing.json`),
    nodeExecution: startNodeExecution({
      runId: 'fixture',
      path: node,
      node: { id: node, kind: 'exec', runtime: 'sh', script: ':' },
      invocation: newNodeInvocation(),
    }),
  }) as Record<string, string>;
}
