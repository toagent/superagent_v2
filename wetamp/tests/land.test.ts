import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { lock } from '../src/archon';
import {
  applyLand,
  captureDelivery,
  excludeCodegraph,
  integratedReceipt,
  protectedTarget,
  type LocalDelivery,
} from '../src/land';
import * as config from '../src/config';
import type { Plan } from '../src/plan';
import type { Land } from '../templates/.archon/scripts/sa-check';
import { directAuxiliaryPreload, fixtureEnv, fixturePlan, gitRepo, sh, tmp } from './helpers';
const saved = { ...process.env };
// prettier-ignore
afterEach(() => { process.env = { ...saved }; });

test.each([
  ['main', true],
  ['dev', true],
  ['release-1.2', true],
  ['feature-x', false],
  ['1.0.0', false],
  ['sa/xxx', false],
] as const)('protectedTarget(%s) = %s', (branch, expected) => {
  expect(protectedTarget(branch)).toBe(expected);
});

test.each(['unknown run', 'missing durable authorization', 'authorization/run mismatch'])(
  'delivery entry loads operator and rejects %s',
  failure => {
    const root = tmp();
    const id = '00000000-nonexistent';
    if (failure !== 'unknown run') {
      mkdirSync(join(root, 'runs'));
      writeFileSync(
        join(root, 'runs', `${id}.json`),
        JSON.stringify({
          run_id: id,
          archon_run_id: id,
          gen_dir: root,
          repo: root,
          branch: 'sa/test',
          workflow: 'test',
        })
      );
    }
    if (failure === 'authorization/run mismatch')
      writeFileSync(
        join(root, 'delivery-authorization.json'),
        JSON.stringify({ run: {}, repo: {} })
      );
    const result = Bun.spawnSync([process.execPath, '--no-env-file', 'src/land.ts'], {
      cwd: join(import.meta.dir, '..'),
      env: fixtureEnv({
        SUPERAGENT_HOME: root,
        ARCHON_HOME: join(root, 'archon'),
        INPUTS_RUN: id,
        WORKFLOW_ID: '',
      }),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 5_000,
    });
    const output = result.stdout.toString() + result.stderr.toString();
    expect(result.exitedDueToTimeout).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(output).not.toContain('require() async module');
    expect(output).toContain(
      failure === 'unknown run' ? `unknown run ${id}` : `delivery: ${failure}`
    );
  }
);

test('delivery entry rejects missing run id', () => {
  const root = tmp();
  const result = Bun.spawnSync(
    [process.execPath, '--no-env-file', join(import.meta.dir, '../src/land.ts')],
    {
      env: fixtureEnv({
        SUPERAGENT_HOME: root,
        ARCHON_HOME: join(root, 'archon'),
        INPUTS_RUN: '',
        NODE_ENV: 'test',
      }),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 5_000,
    }
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('delivery: missing run id');
});

// prettier-ignore
const fixture = () => {
  const root = tmp(), repo = gitRepo(root), worktree = join(root, 'worker'), art = join(root, 'art');
  mkdirSync(art);
  sh('git config user.name t && git config user.email t@l', repo);
  sh(`git worktree add -qb sa/land '${worktree}'`, repo);
  sh('echo delivery > delivery.txt && git add delivery.txt && git -c user.name=t -c user.email=t@l commit -qm delivery', worktree);
  const head = sh('git rev-parse HEAD', worktree).trim();
  const land: Land = { repo, target: 'main', ff: true, branch: 'sa/land', head, commands: [], debt: [] };
  const run = { id: 'r', status: 'completed' as const, working_path: worktree, nodes: [{ nodeId: 'land', state: 'completed' }] };
  return { root, repo, worktree, art, land, run };
};

const deliveryFixture = () => {
  const f = fixture();
  sh('git branch -m wetamp', f.repo);
  f.land.target = 'wetamp';
  const delivery: LocalDelivery = {
    task: 'r',
    target: captureDelivery(f.repo),
    contract: 'generated-contract',
    title: 'Deliver feature',
    evidence: f.art,
    receipt: join(f.art, 'delivery.json'),
  };
  return { ...f, delivery, context: { repo: f.repo, base_ref: 'main', delivery } };
};

test.each(['all-hit', 'partial', 'uncacheable', 'tree-changed'])(
  'LAND_ACCEPT_CACHE reruns only checks whose fingerprint changed: %s',
  kind => {
    const f = deliveryFixture();
    const counter = join(f.root, 'counter');
    const checks = ['a', 'b'].map(name => ({
      cmd: `echo ${name} >> '${counter}'`,
      timeout_s: 2,
      cache: kind !== 'uncacheable',
    }));
    // prettier-ignore
    const planPath = fixturePlan(f.root, f.repo, p => {
      p.environment = [];
      p.packages = [{ id: 'p', accept: checks }];
    });
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as Plan;
    const preload = directAuxiliaryPreload();
    // prettier-ignore
    const accept = (cwd: string, tag: string) => Bun.spawnSync([process.execPath, join(import.meta.dir, '../templates/.archon/scripts/sa-check.ts')], {
      cwd, env: fixtureEnv({ ARTIFACTS_DIR: f.art, BUN_OPTIONS: `${process.env.BUN_OPTIONS ?? ''} --preload=${preload}`, INPUTS_KIND: 'accept', INPUTS_PLAN: planPath, INPUTS_PKGS: 'p', INPUTS_TAG: tag }), stdout: 'pipe', stderr: 'pipe',
    });
    expect(accept(f.worktree, 'verify-p').exitCode).toBe(0);
    if (kind === 'partial') {
      plan.packages[0]!.accept[1]!.cmd = `echo changed >> '${counter}'`;
      writeFileSync(planPath, JSON.stringify(plan));
    }
    if (kind === 'tree-changed') {
      writeFileSync(join(f.worktree, 'change'), 'tree');
      sh('git add change && git commit -qm change', f.worktree);
      f.land.head = sh('git rev-parse HEAD', f.worktree).trim();
    }
    const before = readFileSync(counter, 'utf8');
    const verify = mock((cwd: string) => accept(cwd, 'landing').exitCode);
    expect(applyLand(f.run, f.land, verify, { ...f.context, plan })?.status).toBe('manual_push');
    expect(
      readFileSync(counter, 'utf8').slice(before.length).trim().split('\n').filter(Boolean)
    ).toHaveLength(kind === 'all-hit' ? 0 : kind === 'partial' ? 1 : 2);
  },
  20_000
);

test.each(['same-tree', 'advanced-tree', 'acceptance-failed', 'acceptance-threw'])(
  'LAND_TIMING measures actual stages without reusable evidence: %s',
  kind => {
    const f = deliveryFixture();
    if (kind === 'advanced-tree') {
      writeFileSync(join(f.repo, 'concurrent.txt'), 'concurrent');
      sh('git add concurrent.txt && git commit -qm concurrent', f.repo);
    }
    const before = sh('git rev-parse HEAD', f.repo);
    const verify = mock((cwd: string) => {
      const candidateTree = sh('git rev-parse HEAD^{tree}', cwd);
      const sourceTree = sh('git rev-parse HEAD^{tree}', f.worktree);
      expect(candidateTree === sourceTree).toBe(kind !== 'advanced-tree');
      if (kind === 'acceptance-threw') throw new Error('verification threw');
      return kind === 'acceptance-failed' ? 1 : 0;
    });
    if (kind.startsWith('acceptance-')) {
      expect(() => applyLand(f.run, f.land, verify, f.context)).toThrow(
        kind === 'acceptance-threw' ? 'verification threw' : 'land: acceptance failed'
      );
      expect(sh('git rev-parse HEAD', f.repo)).toBe(before);
      expect(existsSync(f.delivery.receipt)).toBe(false);
    } else {
      expect(applyLand(f.run, f.land, verify, f.context)?.status).toBe('manual_push');
    }
    expect(verify).toHaveBeenCalledTimes(1);
    const log = readFileSync(join(f.art, 'land-environment.log'), 'utf8');
    const timings = [...log.matchAll(/^# land stage=(\w+) attempt=0 ms=([\d.]+)$/gm)];
    expect(timings.map(match => match[1])).toEqual(
      kind.startsWith('acceptance-')
        ? ['environment', 'acceptance']
        : ['environment', 'acceptance', 'integrate']
    );
    for (const match of timings) {
      expect(Number.isFinite(Number(match[2]))).toBe(true);
      expect(Number(match[2])).toBeGreaterThanOrEqual(0);
    }
  }
);

test.each(['pass', 'fail'])('LAND_ENVIRONMENT reuses plan setup only in candidate: %s', kind => {
  const f = deliveryFixture();
  writeFileSync(join(f.worktree, '.gitignore'), '.prepared/\n');
  sh('git add .gitignore && git commit -qm ignore-environment', f.worktree);
  f.land.head = sh('git rev-parse HEAD', f.worktree).trim();
  const setup = 'mkdir -p .prepared && pwd -P > .prepared/cwd';
  const packageSetup = kind === 'pass' ? 'touch .prepared/package' : 'exit 23';
  const planPath = fixturePlan(f.root, f.repo, p => {
    p.environment = [{ cmd: setup, timeout_s: 2 }];
    p.packages = [
      {
        id: 'p',
        environment: [{ cmd: packageSetup, timeout_s: 2 }],
        accept: [{ cmd: 'test -f .prepared/package', timeout_s: 2 }],
      },
    ];
  });
  const plan = JSON.parse(readFileSync(planPath, 'utf8')) as Plan;
  const before = sh('git rev-parse HEAD', f.repo);
  const preload = directAuxiliaryPreload();
  process.env.BUN_OPTIONS = `${process.env.BUN_OPTIONS ?? ''} --preload=${preload}`;
  if (kind === 'pass') {
    const prepared = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, '../templates/.archon/scripts/sa-check.ts')],
      {
        cwd: f.worktree,
        env: { ...process.env, INPUTS_KIND: 'env', INPUTS_PLAN: planPath, ARTIFACTS_DIR: f.art },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    expect(prepared.exitCode).toBe(0);
    expect(sh('test -f .prepared/package', f.worktree)).toBe('');
  }
  const verify = mock((cwd: string) => {
    expect(cwd).not.toBe(f.repo);
    expect(cwd).not.toBe(f.worktree);
    expect(readFileSync(join(cwd, '.prepared/cwd'), 'utf8').trim()).toBe(realpathSync(cwd));
    return Bun.spawnSync(['sh', '-c', 'test -f .prepared/package'], { cwd }).exitCode;
  });
  const context = { ...f.context, plan };
  if (kind === 'pass') {
    expect(applyLand(f.run, f.land, verify, context)?.status).toBe('manual_push');
    expect(verify).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(f.worktree, '.prepared/cwd'), 'utf8').trim()).toBe(f.worktree);
  } else {
    let error: unknown;
    try {
      applyLand(f.run, f.land, verify, context);
    } catch (e) {
      error = e;
    }
    expect(error).toHaveProperty('name', 'land_environment_failed');
    expect((error as Error).message).toContain('exit 23');
    expect((error as Error).message).toContain('environment.log');
    expect(verify).not.toHaveBeenCalled();
    expect(sh('git rev-parse HEAD', f.repo)).toBe(before);
    expect(existsSync(join(f.worktree, '.prepared'))).toBe(false);
    const log = readFileSync(join(f.art, 'land-environment.log'), 'utf8');
    expect(log).toMatch(/# land stage=environment attempt=0 ms=[\d.]+/);
    expect(log).not.toContain('# land stage=acceptance');
  }
  expect(existsSync(join(f.repo, '.prepared'))).toBe(false);
});

test.each(['valid', 'unmerged', 'foreign', 'contract', 'launch', 'advanced', 'missing'])(
  'CARD_Y integration projection requires bound receipt and Git history: %s',
  kind => {
    const f = deliveryFixture();
    const receipt = applyLand(f.run, f.land, () => 0, f.context);
    expect(receipt?.status).toBe('manual_push');
    if (!receipt || receipt.status !== 'manual_push') throw new Error('missing fixture receipt');
    if (kind === 'unmerged') {
      // Move only this scratch target back; a supplied success receipt is insufficient.
      sh(`git checkout --detach && git branch -f wetamp '${f.delivery.target.head}'`, f.repo);
    }
    if (kind === 'foreign') receipt.task = 'other';
    if (kind === 'contract') receipt.contract = 'other';
    if (kind === 'launch') f.delivery.target.head = receipt.target.head = '1'.repeat(40);
    if (kind === 'advanced') sh('git commit --allow-empty -qm later', f.repo);
    expect(
      integratedReceipt(kind === 'missing' ? undefined : receipt, f.land.head, f.delivery)
    ).toEqual(['valid', 'advanced'].includes(kind) ? receipt : undefined);
  }
);

test.each([
  'fresh',
  'integrated',
  'missing',
  'https-source',
  'https-common',
  'https-worker',
  'https-nested',
  'original-url',
])(
  'LAND_SUBMODULE initializes local candidate before acceptance: %s',
  kind => {
    const f = deliveryFixture();
    const upstream = gitRepo(tmp());
    const nested = kind === 'https-nested' ? gitRepo(tmp()) : undefined;
    if (nested) {
      sh(`git -c protocol.file.allow=always submodule add '${nested}' nested`, upstream);
      sh(
        'git config --file .gitmodules submodule.nested.url https://127.0.0.1:1/nested.git',
        upstream
      );
      sh('git add .gitmodules && git commit -qm nested', upstream);
    }
    const path = 'upstream/agent-zero';
    sh(`git -c protocol.file.allow=always submodule add '${upstream}' '${path}'`, f.worktree);
    if (nested)
      sh(
        `git -c protocol.file.allow=always -c submodule.nested.url='${nested}' submodule update --init`,
        join(f.worktree, path)
      );
    if (kind.startsWith('https-'))
      sh(
        `git config --file .gitmodules submodule.${path}.url https://127.0.0.1:1/unreachable.git`,
        f.worktree
      );
    if (kind === 'missing')
      sh(`git update-index --cacheinfo 160000,${'1'.repeat(40)},${path}`, f.worktree);
    sh('git add .gitmodules && git commit -qm submodule', f.worktree);
    f.land.head = sh('git rev-parse HEAD', f.worktree).trim();
    if (kind === 'missing') {
      // An uninitialized author checkout stays clean despite the unavailable gitlink commit.
      rmSync(join(f.worktree, path), { recursive: true, force: true });
      mkdirSync(join(f.worktree, path));
    }
    if (kind === 'integrated') sh('git merge --ff-only sa/land', f.repo);
    if (kind === 'https-source' || kind === 'https-common') {
      sh('git merge --ff-only sa/land', f.repo);
      sh(`git -c protocol.file.allow=always clone '${upstream}' '${path}'`, f.repo);
      if (kind === 'https-common') {
        const common = sh('git rev-parse --path-format=absolute --git-common-dir', f.repo).trim();
        mkdirSync(join(common, 'modules', 'upstream'), { recursive: true });
        sh(`mv '${path}/.git' '${common}/modules/${path}'`, f.repo);
        rmSync(join(f.repo, path), { recursive: true, force: true });
        mkdirSync(join(f.repo, path));
      }
    }
    if (kind === 'original-url' || kind === 'https-common' || kind === 'https-source') {
      rmSync(join(f.worktree, path), { recursive: true, force: true });
      mkdirSync(join(f.worktree, path));
    }
    const common = sh('git rev-parse --path-format=absolute --git-common-dir', f.repo).trim();
    const configBefore = readFileSync(join(common, 'config'), 'utf8');
    const targetBefore = sh('git rev-parse HEAD', f.repo);
    const sourceBefore = sh('git status --porcelain', f.worktree);
    const sourceSubmodule = sh('git rev-parse HEAD', upstream);
    const worktreesBefore = sh('git worktree list --porcelain', f.repo);
    const plan = fixturePlan(f.root, f.repo, p => {
      p.packages = [{ id: 'p', accept: [{ cmd: `test -f ${path}/README.md`, timeout_s: 2 }] }];
    });
    // Watchdog process behavior is covered separately; retain real Git and acceptance here.
    const preload = directAuxiliaryPreload();
    const verify = mock((cwd: string) => {
      expect(sh('git rev-parse HEAD', join(cwd, path))).toBe(sourceSubmodule);
      if (nested)
        expect(sh('git rev-parse HEAD', join(cwd, path, 'nested'))).toBe(
          sh('git rev-parse HEAD', nested)
        );
      expect(sh('git status --porcelain', cwd)).toBe('');
      const result = Bun.spawnSync(
        [process.execPath, join(import.meta.dir, '../templates/.archon/scripts/sa-check.ts')],
        {
          cwd,
          env: {
            ...process.env,
            BUN_OPTIONS: `${process.env.BUN_OPTIONS ?? ''} --preload=${preload}`,
            INPUTS_KIND: 'accept',
            INPUTS_PLAN: plan,
            INPUTS_PKGS: 'p',
            INPUTS_TAG: 'land-submodule',
            ARTIFACTS_DIR: f.art,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        }
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(join(f.art, 'land-submodule.json'), 'utf8'))).toHaveProperty(
        'workspace_clean',
        true
      );
      return result.exitCode;
    });
    const probe = spyOn(config, 'runtimeFingerprint').mockReturnValue('fixture');
    try {
      if (kind === 'missing') {
        expect(() => applyLand(f.run, f.land, verify, f.context)).toThrow(
          /submodule initialization failed \(exit \d+\); paths: .*upstream\/agent-zero; log tail:/
        );
        expect(verify).not.toHaveBeenCalled();
        expect(sh('git rev-parse HEAD', f.repo)).toBe(targetBefore);
        expect(sh('git worktree list --porcelain', f.repo)).toBe(worktreesBefore);
        expect(existsSync(f.delivery.receipt)).toBe(false);
      } else {
        expect(applyLand(f.run, f.land, verify, f.context)?.status).toBe('manual_push');
        expect(verify).toHaveBeenCalledTimes(1);
      }
      expect(sh('git status --porcelain', f.worktree)).toBe(sourceBefore);
      expect(readFileSync(join(common, 'config'), 'utf8')).toBe(configBefore);
      if (!['missing', 'https-common', 'https-source', 'original-url'].includes(kind))
        expect(sh('git rev-parse HEAD', join(f.worktree, path))).toBe(sourceSubmodule);
      expect(existsSync(join(f.repo, path, 'README.md'))).toBe(kind === 'https-source');
    } finally {
      probe.mockRestore();
    }
  },
  10_000
);

test.each(['missing', 'corrupt', 'advanced', 'mismatch', 'interrupted', 'accept-fail', 'valid'])(
  'delivery already integrated recovery: %s requires current acceptance or a matching receipt',
  kind => {
    const f = deliveryFixture(),
      probe = spyOn(config, 'runtimeFingerprint').mockReturnValue('fixture');
    const verify = mock(() => 0);
    try {
      let first: ReturnType<typeof applyLand> = undefined;
      if (kind === 'interrupted') {
        f.delivery.receipt = join(f.art, 'missing', 'delivery.json');
        expect(() => applyLand(f.run, f.land, verify, f.context)).toThrow();
        mkdirSync(join(f.art, 'missing'));
      } else first = applyLand(f.run, f.land, verify, f.context);
      if (kind === 'missing' || kind === 'accept-fail') unlinkSync(f.delivery.receipt);
      if (kind === 'corrupt') writeFileSync(f.delivery.receipt, '{');
      if (kind === 'advanced')
        sh('echo later > later.txt && git add later.txt && git commit -qm later', f.repo);
      if (kind === 'mismatch') f.delivery.contract = 'different-contract';
      const before = sh('git rev-parse HEAD', f.repo).trim();
      let candidate = '';
      const recover = mock((cwd: string) => {
        candidate = cwd;
        expect(cwd).not.toBe(f.repo);
        expect(sh('git rev-parse HEAD', cwd).trim()).toBe(before);
        expect(readFileSync(join(cwd, 'delivery.txt'), 'utf8')).toBe('delivery\n');
        if (kind === 'advanced')
          expect(readFileSync(join(cwd, 'later.txt'), 'utf8')).toBe('later\n');
        return kind === 'accept-fail' ? 1 : 0;
      });
      if (kind === 'accept-fail') {
        expect(() => applyLand(f.run, f.land, recover, f.context)).toThrow('acceptance failed');
        expect(existsSync(f.delivery.receipt)).toBe(false);
      } else {
        const git = spyOn(Bun, 'spawnSync');
        let second: ReturnType<typeof applyLand>;
        try {
          second = applyLand(f.run, f.land, recover, f.context);
          expect(git.mock.calls.some(([cmd]) => cmd.includes('push'))).toBe(false);
          if (kind === 'valid') {
            expect(
              git.mock.calls.some(
                ([cmd]) => cmd.includes('merge') || cmd.includes('install') || cmd.includes('add')
              )
            ).toBe(false);
          }
        } finally {
          git.mockRestore();
        }
        expect(second).toMatchObject({
          accepted: before,
          integrated: before,
          status: 'manual_push',
          contract: f.delivery.contract,
        });
        expect(JSON.parse(readFileSync(f.delivery.receipt, 'utf8'))).toEqual(second);
        expect(second?.push).toBe(`git -C '${f.delivery.target.checkout}' push origin 'wetamp'`);
        if (kind === 'valid') expect(second).toEqual(first);
        else {
          expect(second).toHaveProperty('target_tip', before);
          const repeated = mock(() => 1);
          expect(applyLand(f.run, f.land, repeated, f.context)).toEqual(second);
          expect(repeated).not.toHaveBeenCalled();
        }
      }
      expect(recover).toHaveBeenCalledTimes(kind === 'valid' ? 0 : 1);
      if (candidate) expect(existsSync(candidate)).toBe(false);
      expect(verify).toHaveBeenCalledTimes(1);
      expect(sh('git rev-parse HEAD', f.repo).trim()).toBe(before);
    } finally {
      probe.mockRestore();
    }
  }
);

test.each(['advance', 'rewrite', 'switch', 'source-drift'])(
  'already integrated acceptance preserves target/source guards: %s',
  kind => {
    const f = deliveryFixture(),
      probe = spyOn(config, 'runtimeFingerprint').mockReturnValue('fixture');
    sh('git merge --ff-only sa/land', f.repo);
    let candidate = '',
      tip = sh('git rev-parse HEAD', f.repo).trim();
    const verify = mock((cwd: string) => {
      candidate = cwd;
      expect(sh('git rev-parse HEAD', cwd).trim()).toBe(tip);
      if (kind === 'advance') sh('git commit --allow-empty -qm concurrent', f.repo);
      if (kind === 'rewrite')
        sh('git reset --hard "$(git commit-tree HEAD^{tree} -m rewritten)"', f.repo);
      if (kind === 'switch') sh('git switch -qc operator', f.repo);
      if (kind === 'source-drift') sh('git commit --allow-empty -qm drift', f.worktree);
      tip = sh('git rev-parse HEAD', f.repo).trim();
      return 0;
    });
    try {
      expect(() => applyLand(f.run, f.land, verify, f.context)).toThrow(
        kind === 'advance'
          ? 'target advanced'
          : kind === 'rewrite'
            ? 'not a descendant'
            : kind === 'switch'
              ? 'target checkout changed'
              : 'source HEAD drifted'
      );
      expect(verify).toHaveBeenCalledTimes(kind === 'advance' ? 3 : 1);
      expect(sh('git rev-parse HEAD', f.repo).trim()).toBe(tip);
      expect(existsSync(f.delivery.receipt)).toBe(false);
      expect(existsSync(candidate)).toBe(false);
      expect(existsSync(f.worktree)).toBe(true);
    } finally {
      probe.mockRestore();
    }
  }
);

test.each(
  [
    'protected',
    'switched',
    'dirty',
    'source-dirty',
    'source-drift',
    'target-rewrite',
    'missing-launch',
    'checkout',
  ].flatMap(kind => [false, true].map(integrated => ({ kind, integrated })))
)(
  'delivery rejects $kind with integrated=$integrated without changing target or discarding source',
  ({ kind, integrated }) => {
    const f = deliveryFixture();
    if (integrated) sh('git merge --ff-only sa/land', f.repo);
    if (kind === 'protected') {
      sh('git branch -m main', f.repo);
      f.delivery.target.branch = 'main';
    }
    if (kind === 'switched') sh('git switch -qc other', f.repo);
    if (kind === 'dirty') writeFileSync(join(f.repo, 'user.txt'), 'keep');
    if (kind === 'source-dirty') writeFileSync(join(f.worktree, 'user.txt'), 'keep');
    if (kind === 'source-drift') sh('git commit --allow-empty -qm drift', f.worktree);
    if (kind === 'target-rewrite')
      sh('git reset --hard "$(git commit-tree HEAD^{tree} -m rewritten)"', f.repo);
    if (kind === 'missing-launch') f.delivery.target.head = '0'.repeat(40);
    if (kind === 'checkout') f.delivery.target.checkout = f.worktree;
    const before = sh('git rev-parse HEAD', f.repo);
    expect(() =>
      applyLand(
        f.run,
        f.land,
        () => {
          throw new Error('must not verify');
        },
        f.context
      )
    ).toThrow(
      kind === 'target-rewrite'
        ? 'not a descendant'
        : kind === 'missing-launch'
          ? 'cannot verify launch HEAD ancestry'
          : undefined
    );
    expect(sh('git rev-parse HEAD', f.repo)).toBe(before);
    expect(existsSync(f.worktree)).toBe(true);
    expect(existsSync(f.delivery.receipt)).toBe(false);
  }
);

// prettier-ignore
test.each(['pass', 'accept-fail', 'rewrite-race'])('same-base deliveries integrate serially: %s', kind => {
  const f = deliveryFixture(), worker = join(f.root, 'second'), launch = { ...f.delivery.target };
  sh(`git worktree add -qb sa/second '${worker}' ${launch.head}`, f.repo);
  sh('echo second > second.txt && git add second.txt && git commit -qm second', worker);
  const land = { ...f.land, branch: 'sa/second', head: sh('git rev-parse HEAD', worker).trim() };
  const delivery = { ...f.delivery, task: 'second', receipt: join(f.art, 'second.json') };
  const context = { ...f.context, delivery }, run = { ...f.run, working_path: worker };
  const probe = spyOn(config, 'runtimeFingerprint').mockReturnValue('fixture');
  let candidate = '', rewritten = '';
  try {
    const first = applyLand(f.run, f.land, () => 0, f.context);
    expect(first?.status).toBe('manual_push');
    expect(first).toHaveProperty('target_tip', launch.head);
    const tip = sh('git rev-parse HEAD', f.repo).trim();
    const verify = mock((cwd: string) => {
      candidate = cwd;
      expect(readFileSync(join(cwd, 'delivery.txt'), 'utf8')).toBe('delivery\n');
      expect(readFileSync(join(cwd, 'second.txt'), 'utf8')).toBe('second\n');
      expect(sh('git rev-parse HEAD', f.repo).trim()).toBe(tip);
      expect(sh('git rev-list --parents -n 1 HEAD', cwd).trim().split(' ').slice(1)).toEqual([tip, land.head]);
      if (kind === 'rewrite-race') {
        sh('git reset --hard "$(git commit-tree HEAD^{tree} -m rewritten)"', f.repo);
        rewritten = sh('git rev-parse HEAD', f.repo).trim();
      }
      return kind === 'accept-fail' ? 1 : 0;
    });
    if (kind === 'pass') {
      const result = applyLand(run, land, verify, context);
      expect(result).toMatchObject({ target: launch, target_tip: tip, status: 'manual_push' });
      expect(result?.integrated).toBe(sh('git rev-parse HEAD', f.repo).trim());
      expect(JSON.parse(readFileSync(delivery.receipt, 'utf8'))).toEqual(result);
      expect(readFileSync(join(f.repo, 'second.txt'), 'utf8')).toBe('second\n');
    } else {
      expect(() => applyLand(run, land, verify, context)).toThrow(kind === 'accept-fail' ? 'acceptance failed' : 'not a descendant');
      expect(sh('git rev-parse HEAD', f.repo).trim()).toBe(rewritten || tip);
      expect(existsSync(join(f.repo, 'second.txt'))).toBe(false);
      expect(existsSync(delivery.receipt)).toBe(false);
    }
    expect(verify).toHaveBeenCalledTimes(1);
    expect(delivery.target).toEqual(launch);
    expect(existsSync(candidate)).toBe(false);
    expect(sh('git rev-parse sa/second', f.repo).trim()).toBe(land.head);
  } finally { probe.mockRestore(); }
});

test('delivery renders local merge comment and does not accept a fabricated receipt', () => {
  const f = deliveryFixture(),
    probe = spyOn(config, 'runtimeFingerprint').mockReturnValue('fixture');
  sh('echo target > target.txt && git add target.txt && git commit -qm target', f.repo);
  f.delivery.target = captureDelivery(f.repo);
  writeFileSync(
    f.delivery.receipt,
    JSON.stringify({ status: 'manual_push', integrated: f.land.head })
  );
  try {
    expect(() => applyLand(f.run, f.land, () => 1, f.context)).toThrow('acceptance failed');
    expect(existsSync(join(f.repo, 'delivery.txt'))).toBe(false);
    applyLand(f.run, f.land, () => 0, f.context);
    expect(sh('git log -1 --format=%B', f.repo)).toContain('Deliver feature\n\nTask: r');
    expect(sh('git merge-base --is-ancestor sa/land HEAD', f.repo).trim()).toBe('');
  } finally {
    probe.mockRestore();
  }
});
// prettier-ignore
test.each(['.', 'wetamp', 'apps/advisor'])('candidate owns the %s workspace graph even with an unchanged lockfile', rel => {
  const f = fixture(), dir = join(f.repo, rel), pkg = join(dir, 'packages/provider');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(f.repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'land-fixture', private: true, workspaces: ['packages/*'], dependencies: { '@land/provider': 'workspace:*' } }));
  const manifest = { name: '@land/provider', version: '1.0.0', exports: { '.': './index.ts' } };
  writeFileSync(join(pkg, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(pkg, 'index.ts'), 'export const owner = "target";\n');
  const install = Bun.spawnSync([process.execPath, 'install'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  expect(install.exitCode).toBe(0);
  sh(`git add .gitignore '${rel}/package.json' '${rel}/bun.lock' '${rel}/packages/provider/package.json' '${rel}/packages/provider/index.ts' && git commit -qm workspace`, f.repo);
  sh('git merge --no-edit main', f.worktree);
  const workerDir = join(f.worktree, rel), workerPkg = join(workerDir, 'packages/provider');
  writeFileSync(join(workerPkg, 'package.json'), JSON.stringify({ ...manifest, exports: { ...manifest.exports, './launch-policy': './launch-policy.ts' } }));
  writeFileSync(join(workerPkg, 'index.ts'), 'export const owner = "candidate";\n');
  writeFileSync(join(workerPkg, 'launch-policy.ts'), 'export const policy = "candidate-policy";\n');
  sh(`git add '${rel}/packages/provider/package.json' '${rel}/packages/provider/index.ts' '${rel}/packages/provider/launch-policy.ts' && git commit -qm candidate-exports`, f.worktree);
  f.land.head = sh('git rev-parse HEAD', f.worktree).trim();
  expect(readFileSync(join(workerDir, 'bun.lock')).equals(readFileSync(join(dir, 'bun.lock')))).toBe(true);
  // Independent nested projects declare setup; root workspaces use shared provisioning.
  const planPath = fixturePlan(f.root, f.repo, p => {
    p.environment = rel === '.' ? [] : [{ cmd: `cd ${rel} && bun install --frozen-lockfile`, timeout_s: 10 }];
  });
  const plan = JSON.parse(readFileSync(planPath, 'utf8')) as Plan;
  const probe = spyOn(config, 'runtimeFingerprint').mockReturnValue('fixture');
  let candidate = '';
  try { applyLand(f.run, f.land, cwd => {
    candidate = cwd;
    const result = Bun.spawnSync([process.execPath, '-e', 'import { owner } from "@land/provider"; import { policy } from "@land/provider/launch-policy"; console.log(owner, policy);'], { cwd: join(cwd, rel), stdout: 'pipe', stderr: 'pipe' });
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe('candidate candidate-policy');
    return result.exitCode;
  }, { repo: f.repo, base_ref: 'main', plan }); } finally { probe.mockRestore(); }
  expect(existsSync(candidate)).toBe(false);
  expect(readFileSync(join(pkg, 'index.ts'), 'utf8')).toContain('candidate');
});
// prettier-ignore
test.each(['current', 'legacy-ref', 'legacy-hash'])('%s apply checks the accepted tree, reuses cache and cleans worktree/branch', mode => {
  const f = fixture(), counter = join(f.root, 'calls');
  const receipt = mode === 'current' ? f.land : { branch: f.land.branch, head: f.land.head, commands: [], debt: [] };
  const plan = fixturePlan(f.root, f.repo, p => { p.packages = [{ id: 'p', accept: [{ cmd: `echo checked >> '${counter}'`, timeout_s: 2, cache: true }] }]; });
  const preload = directAuxiliaryPreload();
  const verify = (cwd: string) => Bun.spawnSync([process.execPath, join(import.meta.dir, '../templates/.archon/scripts/sa-check.ts')], {
    cwd, env: { ...process.env, BUN_OPTIONS: `${process.env.BUN_OPTIONS ?? ''} --preload=${preload}`, INPUTS_KIND: 'accept', INPUTS_PLAN: plan, INPUTS_PKGS: 'p', INPUTS_TAG: 'land-check', ARTIFACTS_DIR: f.art }, stdout: 'pipe', stderr: 'pipe',
  }).exitCode;
  expect(verify(f.worktree)).toBe(0);
  const probe = spyOn(config, 'runtimeFingerprint').mockReturnValue('fixture');
  const original = sh('git rev-parse HEAD', f.repo);
  let candidate = '';
  try { applyLand(f.run, receipt, cwd => { candidate = cwd; expect(cwd).not.toBe(f.repo); expect(sh('git symbolic-ref --short HEAD', f.repo).trim()).toBe('main'); expect(sh('git rev-parse HEAD', f.repo)).toBe(original); expect(sh('git rev-parse HEAD', cwd).trim()).toBe(f.land.head); return verify(cwd); }, { repo: f.repo, base_ref: mode === 'legacy-hash' ? sh('git rev-parse main', f.repo).trim() : 'origin/main', launch_branch: 'main' }); }
  finally { probe.mockRestore(); }
  expect(sh('git rev-parse HEAD', f.repo).trim()).toBe(f.land.head);
  expect(readFileSync(counter, 'utf8')).toBe('checked\n');
  expect(readFileSync(join(f.art, 'land-check.log'), 'utf8')).toContain('reused pass');
  expect(existsSync(f.worktree)).toBe(false);
  expect(existsSync(candidate)).toBe(false);
  expect(sh('git branch --list sa/land', f.repo).trim()).toBe('');
});
// prettier-ignore
test.each(['pass', 'accept-fail', 'conflict', 'target-race', 'retry-success'])('diverged target: %s preserves branches until verified and removes temporary worktree', kind => {
  const f = fixture(); f.land.ff = false;
  sh('echo target > README.md && git add README.md && git commit -qm target', f.repo);
  if (kind === 'conflict') {
    sh('echo worker > README.md && git add README.md && git commit -qm worker', f.worktree);
    f.land.head = sh('git rev-parse HEAD', f.worktree).trim();
  }
  const before = sh('git rev-parse main', f.repo), worker = sh('git rev-parse sa/land', f.repo), worktrees = sh('git worktree list --porcelain', f.repo);
  let candidate = '', accepted = '', calls = 0, targetAfter = before;
  const verify = (cwd: string) => {
    candidate = cwd; calls++;
    expect(sh('git rev-parse main', f.repo)).toBe(targetAfter);
    expect(sh('git symbolic-ref --short HEAD', f.repo).trim()).toBe('main');
    accepted = sh('git rev-parse HEAD', cwd);
    expect(sh('git rev-list --parents -n 1 HEAD', cwd).trim().split(' ')).toEqual([accepted.trim(), targetAfter.trim(), worker.trim()]);
    expect(readFileSync(join(cwd, 'delivery.txt'), 'utf8')).toBe('delivery\n');
    expect(readFileSync(join(cwd, 'README.md'), 'utf8')).toBe('target\n');
    if (kind === 'target-race' || (kind === 'retry-success' && calls === 1)) { sh('git commit --allow-empty -qm concurrent', f.repo); targetAfter = sh('git rev-parse HEAD', f.repo); }
    return kind === 'accept-fail' ? 1 : 0;
  };
  const probe = spyOn(config, 'runtimeFingerprint').mockReturnValue('fixture');
  try {
    if (kind === 'pass' || kind === 'retry-success') applyLand(f.run, f.land, verify);
    else expect(() => applyLand(f.run, f.land, verify)).toThrow(kind === 'conflict' ? 'README.md' : kind === 'target-race' ? 'target advanced' : 'acceptance failed');
  } finally { probe.mockRestore(); }
  expect(calls).toBe(kind === 'conflict' ? 0 : kind === 'target-race' ? 3 : kind === 'retry-success' ? 2 : 1);
  if (candidate) expect(existsSync(candidate)).toBe(false);
  expect(sh('git rev-parse main', f.repo)).toBe(kind === 'pass' || kind === 'retry-success' ? accepted : targetAfter);
  if (kind !== 'pass' && kind !== 'retry-success') {
    expect(sh('git rev-parse sa/land', f.repo)).toBe(worker);
    expect(sh('git worktree list --porcelain', f.repo)).toBe(kind === 'target-race' ? worktrees.replace(`HEAD ${before.trim()}`, `HEAD ${targetAfter.trim()}`) : worktrees);
  }
});
// prettier-ignore
test('apply refuses a target checkout changed during acceptance', () => {
  const f = fixture(), before = sh('git rev-parse main', f.repo);
  let candidate = '';
  const probe = spyOn(config, 'runtimeFingerprint').mockReturnValue('fixture');
  try { expect(() => applyLand(f.run, f.land, cwd => {
    candidate = cwd;
    sh('git switch -qc operator', f.repo);
    return 0;
  })).toThrow('target checkout changed'); } finally { probe.mockRestore(); }
  expect(sh('git rev-parse main', f.repo)).toBe(before);
  expect(sh('git rev-parse operator', f.repo)).toBe(before);
  expect(sh('git symbolic-ref --short HEAD', f.repo).trim()).toBe('operator');
  expect(existsSync(candidate)).toBe(false);
});
// prettier-ignore
test.each(['dirty', 'tree'])('apply refuses %s before advancing the target', kind => {
  const f = fixture(), before = sh('git rev-parse HEAD', f.repo);
  if (kind === 'dirty') writeFileSync(join(f.repo, 'untracked'), 'keep');
  else sh('echo change >> delivery.txt && git add delivery.txt && git -c user.name=t -c user.email=t@l commit -qm changed', f.worktree);
  expect(() => applyLand(f.run, f.land, () => { throw new Error('must not verify'); })).toThrow(kind === 'dirty' ? 'dirty' : 'tree differs');
  expect(sh('git rev-parse HEAD', f.repo)).toBe(before);
});
// prettier-ignore
test.each([true, false])('conflicts use PATH mergiraf only in the candidate; available=%s', available => {
  const f = fixture(), bin = join(f.root, 'bin'); mkdirSync(bin);
  sh('echo target > README.md && git add README.md && git commit -qm target', f.repo);
  sh('echo worker > README.md && git add README.md && git commit -qm worker', f.worktree);
  f.land.head = sh('git rev-parse HEAD', f.worktree).trim();
  const before = sh('git rev-parse HEAD', f.repo);
  const solver = join(bin, 'mergiraf');
  writeFileSync(solver, '#!/bin/sh\nprintf "resolved\\n" > "$2"\n', { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const lookup = available ? undefined : spyOn(Bun, 'which').mockReturnValue(null);
  const probe = spyOn(config, 'runtimeFingerprint').mockReturnValue('fixture');
  let candidate = '';
  try {
    const apply = () => applyLand(f.run, f.land, cwd => {
      candidate = cwd;
      expect(readFileSync(join(cwd, 'README.md'), 'utf8')).toBe('resolved\n');
      expect(sh('git rev-parse HEAD', f.repo)).toBe(before);
      expect(sh('git log -1 --format=%s', cwd).trim()).toBe('Merge sa/land');
      return 0;
    });
    if (available) apply(); else expect(apply).toThrow('merge conflicts:\nREADME.md');
  } finally { lookup?.mockRestore(); probe.mockRestore(); }
  if (candidate) expect(existsSync(candidate)).toBe(false);
  expect(readFileSync(join(f.repo, 'README.md'), 'utf8')).toBe(available ? 'resolved\n' : 'target\n');
});

test.each([false, true])(
  'land holds the common repository/target lease through verification and releases on failure; integrated=%s',
  integrated => {
    const f = deliveryFixture();
    if (integrated) sh('git merge --ff-only sa/land', f.repo);
    const common = sh('git rev-parse --path-format=absolute --git-common-dir', f.worktree).trim();
    const file = join(
      common,
      `sa-land-${createHash('sha256').update('wetamp').digest('hex')}.lock`
    );
    const probe = spyOn(config, 'runtimeFingerprint').mockReturnValue('fixture');
    try {
      expect(() =>
        applyLand(
          f.run,
          f.land,
          () => {
            const competing = lock(file);
            if (competing.ok) competing.release();
            expect(competing.ok).toBe(false);
            return 1;
          },
          f.context
        )
      ).toThrow('acceptance failed');
      const next = lock(file);
      expect(next.ok).toBe(true);
      if (next.ok) next.release();
    } finally {
      probe.mockRestore();
    }
  }
);

test('delivery defaults: land needs no selftest receipt and never triggers diagnostics', () => {
  const f = fixture();
  process.env.SUPERAGENT_HOME = f.root;
  const diagnosis = spyOn(config, 'runtimeFingerprint').mockImplementation(() => {
    throw new Error('unexpected diagnosis');
  });
  try {
    expect(existsSync(join(f.root, 'selftest.json'))).toBe(false);
    applyLand(f.run, f.land, () => 0);
    expect(sh('git rev-parse HEAD', f.repo).trim()).toBe(f.land.head);
    expect(diagnosis).not.toHaveBeenCalled();
    expect(existsSync(join(f.root, 'selftest-land.log'))).toBe(false);
  } finally {
    diagnosis.mockRestore();
  }
});

test.each([0, 1])('codegraph sync after ff is best effort (exit %i)', exit => {
  const f = fixture(),
    bin = join(f.root, 'bin'),
    marker = join(f.root, 'synced');
  mkdirSync(bin);
  const command = join(bin, 'codegraph');
  writeFileSync(command, `#!/bin/sh\nprintf '%s' "$PWD:$1" > '${marker}'\nexit ${exit}\n`);
  chmodSync(command, 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  excludeCodegraph(f.worktree);
  excludeCodegraph(f.repo);
  mkdirSync(join(f.repo, '.codegraph'));
  writeFileSync(join(f.repo, '.codegraph/index'), 'fixture');
  expect(sh('git status --porcelain', f.repo)).toBe('');
  applyLand(f.run, f.land, () => 0);
  expect(sh('git rev-parse HEAD', f.repo).trim()).toBe(f.land.head);
  expect(readFileSync(marker, 'utf8')).toBe(`${f.repo}:sync`);
  const exclude = sh('git rev-parse --path-format=absolute --git-path info/exclude', f.repo).trim();
  expect(
    readFileSync(exclude, 'utf8')
      .split('\n')
      .filter(line => line === '.codegraph/')
  ).toHaveLength(1);
  expect(sh('git status --porcelain', f.repo)).toBe('');
});

// prettier-ignore
test('dirty target lists tracked/untracked paths, handles renames, and caps at 20', () => {
  const f = fixture();
  const tracked = sh('git ls-files', f.repo).trim().split('\n')[0];
  sh(`git mv '${tracked}' renamed.txt`, f.repo);
  for (let i = 0; i < 22; i++) writeFileSync(join(f.repo, `u${String(i).padStart(2, '0')}`), 'keep');
  let message = '';
  try { applyLand(f.run, f.land, () => { throw new Error('must not verify'); }); }
  catch (e) { message = (e as Error).message; }
  expect(message).toContain('tracked: "renamed.txt"');
  expect(message).toContain('untracked: "u00"');
  expect(message).not.toContain('"u19"');
  expect(message).toContain('3 more paths');
  expect(sh('git rev-parse HEAD', f.repo).trim()).not.toBe(f.land.head);
});
