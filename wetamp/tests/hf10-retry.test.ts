import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lastJson } from '../src/archon';
import { generate } from '../src/generate';
import { WETAMP } from '../src/config';
import type { Plan } from '../src/plan';
import { fixturePlan, gitRepo, sh, tmp } from './helpers';

for (const scope of ['package', 'milestone', 'budget'] as const)
  test(`HF10 fake retry preserves ${scope} scope`, () => {
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
    if (scope === 'budget') plan.budget.launches = 3;
    // FC permits repair-limit debt in non-strict G1; this fixture needs a held gate.
    if (scope === 'milestone') plan.mode = 'strict';
    const py = join(root, 'supervisor.py');
    writeFileSync(
      py,
      `import json, sys\nfrom pathlib import Path\np = Path(__file__).parent\nwith (p / 'questions').open('a') as f: f.write(' '.join(sys.argv[1:]) + '\\n')\nif sys.argv[1] == 'notify':\n    (p / 'receipt.json').write_text(json.dumps(sys.argv[1:]))\n    print(json.dumps({'ok': True}))\nelse:\n    print('ask-1' if sys.argv[1] == 'ask' else (p / 'answer').read_text())\n`
    );
    writeFileSync(join(root, 'answer'), 'pending');
    const env = {
      ...process.env,
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
      if (scope === 'budget' && node.id === 'verify-W3')
        node.with!.archon = join(WETAMP, 'bin/archon');
      if (node.id.startsWith('code-')) {
        if (scope === 'package' && node.id === 'code-W3') {
          const blocked = {
            status: 'blocked',
            changed_files: [],
            quick_checks: [],
            notes: 'fixture',
            blockers: [],
            error_class: 'redline',
            deviations: [],
            needs: [],
          };
          node.bash = `if test -f '${ready}'; then\n${node.bash}\nelse\necho '${JSON.stringify(blocked)}'\nfi`;
        }
        node.bash = `echo '${node.id}' >> '${trace}'\n${node.bash}`;
      }
      if (scope === 'milestone' && /^review-m1-r[23]$/.test(node.id)) {
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
      const p = Bun.spawnSync([join(WETAMP, 'bin/superagent'), ...args], {
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      return { code: p.exitCode, out: lastJson(p.stdout.toString()), err: p.stderr.toString() };
    };
    const archon = (...args: string[]) => {
      const p = Bun.spawnSync([join(WETAMP, 'bin/archon'), ...args, '--json'], {
        env,
        cwd: repo,
        stdout: 'pipe',
        stderr: 'pipe',
      });
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
    expect(sa('wait', id, '--timeout', '120').out).toMatchObject({
      state: scope !== 'milestone' ? 'failed' : 'held:gate',
      node: scope !== 'milestone' ? 'verify-W3' : 'gate-m1-r3',
    });
    const counts = () =>
      Object.fromEntries(
        plan.packages.map(p => [
          `code-${p.id}`,
          readFileSync(trace, 'utf8')
            .split('\n')
            .filter(n => n === `code-${p.id}`).length,
        ])
      );
    expect(counts()).toEqual(
      scope !== 'milestone'
        ? { 'code-W1': 1, 'code-W2': 1, 'code-W3': 1, 'code-W4': 0 }
        : { 'code-W1': 1, 'code-W2': 1, 'code-W3': 1, 'code-W4': 1 }
    );
    expect(sa('supervise-tick').code).toBe(0);
    const question = readFileSync(join(root, 'questions'), 'utf8');
    expect(question).toContain(scope !== 'milestone' ? '重派W3编码→验收一次' : '重跑m1全部4包');
    writeFileSync(ready, 'ready');
    writeFileSync(join(root, 'answer'), 'yes');
    expect(sa('supervise-tick').code).toBe(0);
    const receiptArgs = JSON.parse(readFileSync(join(root, 'receipt.json'), 'utf8')) as string[];
    const receipt = receiptArgs[receiptArgs.indexOf('--body') + 1];
    expect(receipt).toContain(
      scope !== 'milestone' ? '已提交包W3编码→验收重跑' : '已提交里程碑m1全部包重跑'
    );
    expect(receipt).toContain(`去向=${String(ack.runId)}`);
    if (scope === 'budget') {
      const grant = JSON.parse(readFileSync(join(gen.dir, 'budget-extra'), 'utf8'));
      expect(grant.attempt).toBe(0);
      expect(Number.isSafeInteger(grant.attempt)).toBe(true);
      expect(existsSync(join(gen.dir, 'attempts/m1'))).toBe(false);
      console.error(`HF10 budget E2E grant: ${JSON.stringify(grant)}`);
    }
    const finished = sa('wait', id, '--timeout', '120');
    expect(finished.out).toMatchObject({ state: 'completed' });
    const expected =
      scope !== 'milestone'
        ? { 'code-W1': 1, 'code-W2': 1, 'code-W3': 2, 'code-W4': 1 }
        : { 'code-W1': 2, 'code-W2': 2, 'code-W3': 2, 'code-W4': 2 };
    expect(counts()).toEqual(expected);
    const ledger = JSON.parse(readFileSync(join(env.SUPERAGENT_HOME, `runs/${id}.json`), 'utf8'));
    expect(ledger.archon_run_id).toBe(ack.runId);
    expect(ledger.adoptions).toBeUndefined();
    console.error(`HF10 ${scope} execution counts: ${JSON.stringify(counts())}`);
  }, 240000);
