// New scratch registry + real CLI/engine only. Never adopts an existing business gate.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Controller } from '../src/coord';

export async function startCanary(
  parent = tmpdir()
): Promise<{ root: string; repo: string; runId: string; engine: string; controller: Controller }> {
  const root = mkdtempSync(join(parent, 'mobile-canary-'));
  process.env.SUPERAGENT_HOME = join(root, 'sa');
  process.env.ARCHON_HOME = join(root, 'sa/archon');
  process.env.DATABASE_URL = '';
  const repo = join(root, 'project'),
    gen = join(root, 'sa/gen');
  for (const path of [repo, gen, join(root, 'sa/runs'), process.env.ARCHON_HOME])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  const git = (...args: string[]): void => {
    const p = Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
    if (p.exitCode) throw new Error('canary scratch git failed');
  };
  git('init', '-q', '-b', 'canary');
  git(
    '-c',
    'user.name=Canary',
    '-c',
    'user.email=canary@localhost',
    'commit',
    '--allow-empty',
    '-qm',
    'harmless canary'
  );
  const workflowDir = join(gen, '.archon/workflows/mobile-canary');
  mkdirSync(workflowDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(workflowDir, 'mobile-canary.yaml'),
    `name: mobile-canary
description: "专属无害真实三选与执行回执；只写 scratch"
interactive: true
worktree:
  enabled: false
nodes:
  - id: choose
    approval:
      message: "无害验收：生成哪种 canary 报告？只写新建 scratch 文件。"
      decisions:
        - id: approve
          label: "生成摘要：只写 canary-result.txt"
        - id: detail
          label: "生成明细：只写 canary-result.txt"
        - id: stop
          label: "结束测试：只写取消记录，不操作业务"
  - id: report
    depends_on: [choose]
    bash: |
      printf '%s\\n' '$choose.output.decision' > canary-result.txt
      cat canary-result.txt
`
  );
  const { archonJson, getRun } = await import('../src/archon');
  const { caller, coord, repoScope } = await import('../src/coord');
  const { writeAtomic } = await import('../src/config');
  const { ledgerPath } = await import('../src/cli');
  const c = coord(),
    who = caller(),
    scope = repoScope(repo);
  const { controller } = c.claim(scope, who);
  const ack = c.mutate(scope, who, () =>
    archonJson(
      ['workflow', 'run', 'mobile-canary', '--workflow-source', gen, '--cwd', repo, '--detach'],
      repo
    )
  );
  if (ack.ok !== true || typeof ack.runId !== 'string')
    throw new Error('canary engine admission failed: ' + JSON.stringify(ack));
  const runId = 'canary-' + crypto.randomUUID();
  const plan = {
    repo,
    base_ref: 'canary',
    budget: { weighted_tokens: 0 },
    packages: [
      {
        id: 'canary',
        title: '无害三选验收',
        goal: '仅 scratch 报告',
        scope: { write: ['canary-result.txt'] },
        risk: 'G0',
        size: 'S',
        accept: [{ cmd: 'test -f canary-result.txt', timeout_s: 10 }],
      },
    ],
  };
  writeAtomic(join(gen, 'plan.json'), JSON.stringify(plan));
  writeAtomic(
    ledgerPath(runId),
    JSON.stringify({
      run_id: runId,
      archon_run_id: ack.runId,
      repo,
      gen_dir: gen,
      plan: join(gen, 'plan.json'),
      branch: 'canary',
      workflow: 'mobile-canary',
      console: 'shell',
      started_at: new Date().toISOString(),
      transcript: ack.transcriptPath,
      log: ack.logPath,
      controller,
    })
  );
  for (const end = Date.now() + 45000; Date.now() < end; ) {
    const run = getRun(ack.runId, repo);
    if (run.status === 'paused') return { root, repo, runId, engine: ack.runId, controller };
    if (['completed', 'failed', 'cancelled'].includes(run.status))
      throw new Error(
        'canary did not reach gate: ' +
          JSON.stringify(run) +
          '\n' +
          (typeof ack.logPath === 'string'
            ? readFileSync(ack.logPath, 'utf8').slice(-3000)
            : 'no log path')
      );
    await Bun.sleep(250);
  }
  throw new Error('canary gate observation timed out; do not retry automatically');
}
if (import.meta.main) console.log(JSON.stringify(await startCanary()));
