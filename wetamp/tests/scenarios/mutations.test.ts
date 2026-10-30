import { expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tmp } from '../helpers';

type Mutation = {
  file: string;
  from: string;
  to: string;
  test: string;
  name: string;
  expectedError: string;
  also?: [string, string];
};
const mutations: Mutation[] = [
  {
    file: 'src/generate.ts',
    from: 'loop_group: {\n        max_iterations: 3,',
    to: 'loop_group: {\n        interactive: true,\n        max_iterations: 3,',
    test: 'tests/generate.test.ts',
    name: 'multi-milestone delivery',
    expectedError: 'interactive',
  },
  {
    file: 'src/land.ts',
    from: 'const who = authorization.run;',
    to: 'const who = caller();',
    test: 'tests/delivery-e2e.test.ts',
    name: 'entry rejects',
    expectedError: 'integration: authorization/run mismatch',
    also: [
      "import { control, coord, repoScope, runScope, same } from './coord';",
      "import { caller, control, coord, repoScope, runScope, same } from './coord';",
    ],
  },
  {
    file: 'src/land.ts',
    from: 'const result = reclaimAdmission(run, action, d), deadline = d.now() + INTEGRATION_RECLAIM_TIMEOUT_MS;',
    to: 'const result = action(), deadline = d.now() + INTEGRATION_RECLAIM_TIMEOUT_MS;',
    test: 'tests/land.test.ts',
    name: 'post-publish reclaim',
    expectedError: 'expected',
  },
  {
    file: 'templates/.archon/scripts/sa-check.ts',
    from: 'artifact_sha256: sha(serialized)',
    to: "artifact_sha256: ''",
    test: 'tests/scenarios/scenario-core.test.ts',
    name: 'S2',
    expectedError: '"nodeId":"verify-p"',
  },
  {
    file: 'src/generate.ts',
    from: "ref.optional(\n          conditionalOutput<{ artifact_sha256: string }>(binding.node),\n          'artifact_sha256',\n          ''\n        ),",
    to: "ref.required(\n          output<{ artifact_sha256: string }>(binding.node),\n          'artifact_sha256'\n        ),",
    test: 'tests/scenarios/scenario-rest.test.ts',
    name: 'S3',
    expectedError: '"reason":"producer-not-run"',
  },
  {
    file: 'src/generate.ts',
    from: "until_bash: untilStatus(publishHandle, 'published'),",
    to: 'until_bash: `test $${publishId}.output.status = published`,',
    test: 'tests/generate.test.ts',
    name: 'multi-milestone delivery',
    expectedError: 'bun -e',
  },
  {
    file: 'templates/.archon/scripts/sa-context.ts',
    from: "(context.refs.head === head || completedGate.verdict === 'fix');",
    to: 'context.refs.head === head;',
    test: 'tests/scenarios/scenario-rest.test.ts',
    name: 'S14a',
    expectedError: 'context: stale review refs',
  },
];

test('project rules run the full wetamp suite for every mutation target', () => {
  const repo = join(import.meta.dir, '../../..');
  const rules = JSON.parse(readFileSync(join(repo, '.superagent/rules.json'), 'utf8')) as {
    required_checks?: {
      when: string[];
      check: { cmd: string; cache?: boolean; requires_prior_pass?: boolean };
    }[];
  };
  const required = rules.required_checks?.find(
    rule => rule.check.cmd === 'cd wetamp && bun run test'
  );
  expect(required?.check).toMatchObject({ cache: true });
  for (const file of new Set(mutations.map(mutation => `wetamp/${mutation.file}`)))
    expect(required?.when.some(pattern => new Bun.Glob(pattern).match(file))).toBe(true);
});

test('known accident mutations each fail a real generated scenario', () => {
  const repo = join(import.meta.dir, '../../..');
  const critical = (text: string) =>
    text
      .split('\n')
      .filter(line => {
        try {
          const event = JSON.parse(line) as { level?: number; msg?: string };
          return (event.level ?? 0) >= 40 || event.msg === 'dag_node_failed';
        } catch {
          return /^(?:\(fail\)|error:|\s+at )/.test(line);
        }
      })
      .slice(-100)
      .join('\n');
  const diagnostic = (label: string, result: { stdout: Uint8Array; stderr: Uint8Array }) => {
    const artifacts = mkdtempSync(join(tmpdir(), 'sa-mutation-evidence-')),
      stdout = result.stdout.toString(),
      stderr = result.stderr.toString();
    writeFileSync(join(artifacts, 'output.log'), `stdout:\n${stdout}\nstderr:\n${stderr}`);
    return `${label}; artifacts=${artifacts}\nstdout critical:\n${critical(stdout).slice(-4000)}\nstderr critical:\n${critical(stderr).slice(-4000)}`;
  };
  const selected = process.env.SCENARIO_MUTATION_ONLY
    ? mutations.filter(value => value.file === process.env.SCENARIO_MUTATION_ONLY)
    : mutations;
  for (const mutation of selected) {
    const baseline = Bun.spawnSync(
      [process.execPath, 'test', '--timeout', '180000', mutation.test, '-t', mutation.name],
      { cwd: join(repo, 'wetamp'), stdout: 'pipe', stderr: 'pipe', timeout: 240_000 }
    );
    if (baseline.exitCode !== 0)
      expect(baseline.exitCode, diagnostic('baseline failed', baseline)).toBe(0);
    const root = tmp(),
      wetamp = join(root, 'wetamp');
    cpSync(join(repo, 'wetamp'), wetamp, {
      recursive: true,
      filter: path => !path.includes('/node_modules') && !path.includes('/.git/'),
    });
    symlinkSync(join(repo, 'packages'), join(root, 'packages'));
    symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'));
    symlinkSync(join(repo, 'wetamp/node_modules'), join(wetamp, 'node_modules'));
    const path = join(wetamp, mutation.file);
    const before = readFileSync(path, 'utf8');
    expect(before, `${mutation.file}: mutation target drifted`).toContain(mutation.from);
    const changed = before.replaceAll(mutation.from, mutation.to);
    if (mutation.also) expect(changed).toContain(mutation.also[0]);
    writeFileSync(
      path,
      mutation.also ? changed.replace(mutation.also[0], mutation.also[1]) : changed
    );
    for (const args of [
      ['init', '-q'],
      ['add', 'wetamp', 'packages', 'node_modules'],
      [
        '-c',
        'user.name=scenario',
        '-c',
        'user.email=scenario@local',
        'commit',
        '-qm',
        `mutation ${mutation.file}`,
      ],
    ]) {
      const git = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
      expect(git.exitCode, git.stderr.toString()).toBe(0);
    }
    const run = Bun.spawnSync(
      [process.execPath, 'test', '--timeout', '180000', mutation.test, '-t', mutation.name],
      {
        cwd: wetamp,
        env: { ...process.env, SCENARIO_MUTATION: mutation.file },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 240_000,
      }
    );
    const failure = `${run.stdout.toString()}\n${run.stderr.toString()}`;
    if (run.exitCode === 0 || !failure.includes(mutation.expectedError)) {
      const evidence = diagnostic(`${mutation.file} did not break ${mutation.name}`, run);
      expect(run.exitCode, evidence).not.toBe(0);
      expect(failure, evidence).toContain(mutation.expectedError);
    }
  }
}, 720_000);
