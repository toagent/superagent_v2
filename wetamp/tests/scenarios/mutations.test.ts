import { expect, test } from 'bun:test';
import { cpSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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
    test: 'tests/scenarios/scenario-core.test.ts',
    name: 'S2',
    expectedError: 'interactive',
  },
  {
    file: 'src/land.ts',
    from: 'const who = authorization.run;',
    to: 'const who = caller();',
    test: 'tests/scenarios/scenario-core.test.ts',
    name: 'S2',
    expectedError: 'integration: authorization/run mismatch',
    also: [
      "import { control, coord, repoScope, same } from './coord';",
      "import { caller, control, coord, repoScope, same } from './coord';",
    ],
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
    test: 'tests/scenarios/scenario-core.test.ts',
    name: 'S2',
    expectedError: 'publish-m1',
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

test('known accident mutations each fail a real generated scenario', () => {
  const repo = join(import.meta.dir, '../../..');
  const selected = process.env.SCENARIO_MUTATION_ONLY
    ? mutations.filter(value => value.file === process.env.SCENARIO_MUTATION_ONLY)
    : mutations;
  for (const mutation of selected) {
    const baseline = Bun.spawnSync(
      [process.execPath, 'test', '--timeout', '180000', mutation.test, '-t', mutation.name],
      { cwd: join(repo, 'wetamp'), stdout: 'pipe', stderr: 'pipe', timeout: 240_000 }
    );
    expect(baseline.exitCode, baseline.stderr.toString()).toBe(0);
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
    expect(run.exitCode, `${mutation.file} did not break ${mutation.name}`).not.toBe(0);
    expect(failure).toContain(mutation.expectedError);
  }
}, 720_000);
